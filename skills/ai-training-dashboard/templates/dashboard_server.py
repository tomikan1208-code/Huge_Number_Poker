"""
学習ダッシュボード サーバー（テンプレート）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
学習プロセスの起動・停止・監視をして、ブラウザに状態を配信する。

【設計の要】データの出どころを2つに分ける:
  1. ディスクのJSONログ … 世代ごとの確定値。プロセスが死んでも残る。これが「正」
  2. 標準出力のパース   … まだJSONに書かれていない進行中の分。ライブ表示専用
  混ぜてはいけない。2は1で上書きされる前提の一時的な値。

ゲームごとに書き換えるのは「■ プロジェクト設定」の部分だけ。
"""

import os
import re
import sys
import json
import time
import shutil
import threading
import subprocess
from flask import Flask, jsonify, request, send_from_directory, Response

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

_BASE = os.path.dirname(os.path.abspath(__file__))


# ══════════════════════════════════════════════════
# ■ プロジェクト設定（ここだけ書き換える）
# ══════════════════════════════════════════════════
APP_TITLE = '<ゲーム名> AI 学習コントロールパネル'
PORT = 5556
ENV_PREFIX = 'GAME'                       # 環境変数の接頭辞
TRAIN_SCRIPT = os.path.join(_BASE, 'train.py')
LOG_FILE = os.path.join(_BASE, 'models', 'ppo_log.json')

# 学習モード名 → train.py に渡す追加引数
MODES = {
    '通常': [],
    # '自己対戦リーグ': ['--league'],
}

# グラフ・表に出す指標。contract に沿ってJSONログへ書かれているもの。
# key はログのキー、fmt は 'rate'（0〜1を%表示）/ 'float' / 'int'
METRICS = [
    {'key': 'win_vs_random', 'label': 'vs Random 勝率', 'fmt': 'rate'},
    {'key': 'win_vs_best',   'label': 'vs Best 勝率',   'fmt': 'rate'},
    {'key': 'loss',          'label': 'Loss',           'fmt': 'float'},
    {'key': 'kl',            'label': 'KL 発散',        'fmt': 'float'},
    {'key': 'fps',           'label': '毎秒ステップ数',  'fmt': 'int'},
    {'key': 'finish_rate',   'label': '決着率',         'fmt': 'float'},
    # ここにゲーム固有の指標を足す（例: 石差・平均獲得資源）
]

# 「名前 → 数値」の入れ子辞書で記録している指標（あれば）
DICT_METRICS = []          # 例: ['deck_win_rates']
# ══════════════════════════════════════════════════


app = Flask(__name__, static_folder='web', static_url_path='/static')

_NUM_KEYS = tuple(m['key'] for m in METRICS) + ('games_finished', 'num_envs')


def _read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return default


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def python_exe():
    """子プロセスを起動するPython。exe化しても学習が起動できるように。"""
    if getattr(sys, 'frozen', False):
        return (os.environ.get(f'{ENV_PREFIX}_PYTHON')
                or shutil.which('python') or shutil.which('py') or 'python')
    return sys.executable


class TrainingManager:
    def __init__(self):
        self.process = None
        self.is_running = False
        self.current_mode = None
        self.logs = []              # 生ログ（進捗行は含めない）
        self.live = None            # 世代の途中経過
        self.live_stats = []        # 標準出力から拾った世代の確定値
        self._lock = threading.Lock()
        self._log_cache = {'mtime': -1, 'records': []}
        self._merged_sig = None
        self._merged_cache = []

    # ── 起動・停止 ──
    def start(self, mode, gens, num_envs):
        if self.is_running:
            return False, '既に学習中です'

        cmd = [python_exe(), TRAIN_SCRIPT] + MODES.get(mode, [])
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        env[f'{ENV_PREFIX}_MAX_GENS'] = str(gens)
        if num_envs:                       # 未指定なら train.py 側でVRAMから自動判定
            env[f'{ENV_PREFIX}_NUM_ENVS'] = str(int(num_envs))

        try:
            self.process = subprocess.Popen(
                cmd, cwd=_BASE, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1)
        except OSError as e:
            return False, f'プロセス起動に失敗: {e}'

        self.is_running = True
        self.current_mode = mode
        self.logs, self.live, self.live_stats = [], None, []
        self._add_log('info', f'🚀 学習を開始します（{mode}）')
        threading.Thread(target=self._read_output, daemon=True).start()
        return True, '学習を開始しました'

    def stop(self):
        if not self.is_running or not self.process:
            return False, '学習は実行されていません'
        self.process.terminate()          # 学習側で後始末できるよう kill ではなく terminate
        self._add_log('warn', '⏹️ 停止を要求しました')
        return True, '停止しました'

    # ── 標準出力の読み取り ──
    def _read_output(self):
        for line in iter(self.process.stdout.readline, ''):
            line = line.rstrip('\n')
            if not line:
                continue
            # 進捗行はタイルに出すだけで生ログには残さない。
            # 毎ステップ出るため、残すと重要な行が押し流される。
            if self._parse(line):
                continue
            tag = 'error' if ('❌' in line or 'Traceback' in line) else \
                  'warn' if '⚠️' in line else 'info'
            self._add_log(tag, line)

        code = self.process.wait()
        self._add_log('success' if code == 0 else 'error',
                      f'学習が終了しました (exit={code})')
        self.is_running = False

    def _add_log(self, tag, text):
        with self._lock:
            self.logs.append({'tag': tag, 'text': text, 'time': time.strftime('%H:%M:%S')})
            self.logs = self.logs[-2000:]

    # contract で定めた2種類の行を読む
    _RE_PROGRESS = re.compile(
        r'\[Progress\](?: Gen (\d+) \|)? Step (\d+)/(\d+)'
        r'(?: \| Done: (\d+)/(\d+))?(?: \(([\d.]+)%\))?(?: \| Speed: ([\d.]+))?')
    _RE_GEN = re.compile(r'\[Gen (\d+)\]')

    def _parse(self, line):
        """進捗行なら True を返す（生ログに残さないため）"""
        m = self._RE_PROGRESS.search(line)
        if m:
            with self._lock:
                self.live = {
                    'episode': int(m.group(1)) if m.group(1) else None,
                    'phase': 'train' if m.group(1) else 'pretest',
                    'step': int(m.group(2)), 'max_steps': int(m.group(3)),
                    'games_finished': int(m.group(4)) if m.group(4) else None,
                    'num_envs': int(m.group(5)) if m.group(5) else None,
                    'finish_rate': float(m.group(6)) if m.group(6) else None,
                    'fps': float(m.group(7)) if m.group(7) else None,
                }
            return True

        m = self._RE_GEN.search(line)
        if m:
            entry = {'episode': int(m.group(1))}
            for key in _NUM_KEYS:                 # "loss: 0.02" 形式を拾う
                mv = re.search(rf'{key}[:=]\s*(-?[\d.]+)', line, re.I)
                if mv:
                    entry[key] = float(mv.group(1))
            with self._lock:
                self.live_stats.append(entry)
                self.live_stats = self.live_stats[-500:]
        return False

    # ── 世代データ（ディスクが正） ──
    def _disk_records(self):
        mtime = _mtime(LOG_FILE)
        if self._log_cache['mtime'] == mtime:
            return self._log_cache['records']
        records = []
        for item in _read_json(LOG_FILE, []):
            if not isinstance(item, dict) or 'episode' not in item:
                continue
            rec = {'episode': item['episode'], 'timestamp': item.get('timestamp')}
            for key in _NUM_KEYS:
                v = item.get(key)
                rec[key] = v if isinstance(v, (int, float)) else None
            for key in DICT_METRICS:
                if isinstance(item.get(key), dict):
                    rec[key] = {k: v for k, v in item[key].items()
                                if isinstance(v, (int, float))}
            records.append(rec)
        records.sort(key=lambda r: r['episode'] or 0)
        self._log_cache = {'mtime': mtime, 'records': records}
        return records

    def records(self):
        """ディスクの確定値に、標準出力のライブ値を重ねる。SSEが頻繁に呼ぶのでキャッシュする。"""
        with self._lock:
            sig = (len(self.live_stats),
                   json.dumps(self.live_stats[-1], sort_keys=True) if self.live_stats else '')
        sig = (_mtime(LOG_FILE), sig)
        if self._merged_sig == sig:
            return self._merged_cache

        by_ep = {r['episode']: dict(r) for r in self._disk_records()}
        with self._lock:
            live_stats = list(self.live_stats)
        for entry in live_stats:
            target = by_ep.setdefault(entry['episode'], {'episode': entry['episode']})
            for k, v in entry.items():
                if target.get(k) is None:
                    target[k] = v
            target.setdefault('live', True)

        merged = [by_ep[e] for e in sorted(by_ep)]
        self._merged_sig, self._merged_cache = sig, merged
        return merged

    @staticmethod
    def _pace(records, window=10):
        """直近の1世代あたり秒数"""
        stamps = [r.get('timestamp') for r in records[-(window + 1):] if r.get('timestamp')]
        if len(stamps) < 2:
            return None
        try:
            fmt = '%Y-%m-%d %H:%M:%S'
            deltas = [time.mktime(time.strptime(b, fmt)) - time.mktime(time.strptime(a, fmt))
                      for a, b in zip(stamps, stamps[1:])]
        except ValueError:
            return None
        good = [d for d in deltas if 0 < d < 86400]
        return round(sum(good) / len(good), 1) if good else None

    def status(self):
        records = self.records()
        latest = records[-1] if records else None
        with self._lock:
            logs, live = self.logs[-200:], (dict(self.live) if self.live else None)
        return {
            'is_running': self.is_running,
            'mode': self.current_mode,
            'live': live,
            'latest': latest,
            'gen_count': len(records),
            'pace_sec': self._pace(records),
            'logs': logs,
            # これが変わったときだけフロントが /api/history を取り直す
            'log_version': f'{_mtime(LOG_FILE):.3f}:{len(records)}',
        }


manager = TrainingManager()


@app.route('/')
def index():
    return send_from_directory('web', 'index.html')


@app.route('/api/config')
def api_config():
    return jsonify({'title': APP_TITLE, 'modes': list(MODES),
                    'metrics': METRICS, 'dict_metrics': DICT_METRICS})


@app.route('/api/status')
def api_status():
    return jsonify(manager.status())


@app.route('/api/history')
def api_history():
    return jsonify({'records': manager.records()})


@app.route('/api/start', methods=['POST'])
def api_start():
    d = request.json or {}
    ok, msg = manager.start(d.get('mode') or next(iter(MODES)),
                            d.get('gens', 20), d.get('num_envs') or 0)
    return jsonify({'ok': ok, 'message': msg})


@app.route('/api/stop', methods=['POST'])
def api_stop():
    ok, msg = manager.stop()
    return jsonify({'ok': ok, 'message': msg})


@app.route('/api/stream')
def api_stream():
    """状態が変わったときだけ送る。ポーリングより軽く、反応も速い。"""
    def generate():
        last = None
        while True:
            st = manager.status()
            live = st.get('live') or {}
            # 進捗の値を署名に含める。ログ件数だけだと上限到達後に更新が止まる。
            sig = (st['is_running'], len(st['logs']), st['log_version'],
                   live.get('step'), live.get('games_finished'), live.get('fps'))
            if sig != last:
                last = sig
                yield f"data: {json.dumps(st, ensure_ascii=False)}\n\n"
            time.sleep(0.5)
    return Response(generate(), mimetype='text/event-stream')


if __name__ == '__main__':
    print(f'  {APP_TITLE}\n  http://localhost:{PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
