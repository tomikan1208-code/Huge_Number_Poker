"""
train.py — 巨大数ポーカー AI の PPO 学習
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
環境は Node（train/env_server.js）が持ち、ここは学習だけを担当する。
巨大数エンジンをPythonに書き直すと「学習環境と実ゲームがズレる」という
最悪のバグを抱えるので、ルールの正は engine.js ただ1つに保つ。

【学習するもの】
  bet      … フォールド / チェック・コール / レイズ3段階 / オールイン
  formula  … 候補（値と難易度のパレート境界）の何番目を提出するか
  exchange … 限界効用の低い順に何枚捨てるか

【学習しないもの】
  「その式を人間が当てられるか」= 認知負荷モデル（js/ai-cognition.js）。
  こちらは人間を模した *固定の物理法則* として扱う。学習で動かすと
  「間違えないAI」に収束してゲームが成立しなくなる。

【報酬】
  1エピソード = 1ハンド・1席。報酬は
      (獲得ポット − そのハンドで出した額) / ビッグブラインド
  つまり bb/hand そのもの。ダッシュボードの主指標と一致する。
  ハンド終端でのみ報酬が入るので割引は行わない（gamma=1）。
  優位性は A = R − V(s)（PPOのクリップ付き方策勾配）。
"""

import os
import sys
import json
import time
import shutil
import traceback
import subprocess
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

_BASE = os.path.dirname(os.path.abspath(__file__))
_MODELS = os.path.join(_BASE, 'models')

# Colab: ランタイムが切れても学習ログが消えないように永続フォルダへ写す
DRIVE_DATA_DIR = '/content/drive/MyDrive/huge_number_poker_checkpoints'

ENV = os.environ.get
MAX_GENS = int(ENV('HNP_MAX_GENS', '30'))
NUM_ENVS = int(ENV('HNP_NUM_ENVS', '0'))          # 0 なら自動
PLAYERS = int(ENV('HNP_PLAYERS', '3'))
SEED = int(ENV('HNP_SEED', '1'))

# 認知プロファイル（＝環境の物理）。GUIからはモード選択で --level が渡る。
LEVEL = ENV('HNP_LEVEL', 'skilled')
if '--level' in sys.argv:
    LEVEL = sys.argv[sys.argv.index('--level') + 1]

# レベルごとに別のモデル・別のログにする。
# 1つのファイルに混ぜると「どのレベルで測った bb/hand なのか」が分からなくなる。
MODEL_NAME = f'ppo_{LEVEL}'
LOG_FILE = os.path.join(_MODELS, f'{MODEL_NAME}_log.json')
CKPT_FILE = os.path.join(_MODELS, f'{MODEL_NAME}.pt')
BEST_FILE = os.path.join(_MODELS, f'{MODEL_NAME}_best.pt')
POLICY_JSON = os.path.join(_BASE, '..', 'models', f'policy_{LEVEL}.json')
DECISIONS_PER_GEN = int(ENV('HNP_DECISIONS', '8192'))
EVAL_EVERY = int(ENV('HNP_EVAL_EVERY', '5'))
EVAL_HANDS = int(ENV('HNP_EVAL_HANDS', '600'))

LR = 3e-4
PPO_EPOCHS = 4
MINIBATCH = 1024
CLIP = 0.2
VF_COEF = 0.5
ENT_COEF = 0.01
MAX_GRAD_NORM = 0.5

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
HEADS = ['bet', 'formula', 'exchange']


# ══════════════════════════════════════════════════
# 永続化（Colab対策）
# ══════════════════════════════════════════════════

def _effective_dir():
    return DRIVE_DATA_DIR if os.path.isdir(DRIVE_DATA_DIR) else _MODELS


def persist_data_file(local_path):
    dest = os.path.join(_effective_dir(), os.path.basename(local_path))
    if os.path.abspath(local_path) == os.path.abspath(dest):
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(local_path, dest)


def recover_data_file(local_path):
    src = os.path.join(_effective_dir(), os.path.basename(local_path))
    if os.path.abspath(local_path) == os.path.abspath(src):
        return
    if os.path.exists(src):
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        shutil.copy2(src, local_path)


# ══════════════════════════════════════════════════
# Node環境とのやりとり
# ══════════════════════════════════════════════════

class NodeEnv:
    """train/env_server.js を子プロセスとして起動し、NDJSONで会話する。"""

    def __init__(self, envs, players, level, seed, config=None):
        node = shutil.which('node') or 'node'
        script = os.path.join(_BASE, 'env_server.js')
        self.proc = subprocess.Popen(
            [node, script],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=_BASE, text=True, encoding='utf-8', errors='replace', bufsize=1)
        hello = self._rpc({'cmd': 'init', 'envs': envs, 'players': players,
                           'level': level, 'seed': seed, 'config': config or {}})
        if not hello.get('ok'):
            raise RuntimeError(f'環境の初期化に失敗: {hello}')
        self.obs_dim = hello['obs_dim']
        self.action_sizes = hello['action_sizes']
        self.requests = hello['requests']
        self.results = hello['results']

    def _rpc(self, msg):
        if self.proc.poll() is not None:
            err = self.proc.stderr.read() if self.proc.stderr else ''
            raise RuntimeError(f'env_server が落ちました (exit={self.proc.returncode})\n{err}')
        self.proc.stdin.write(json.dumps(msg) + '\n')
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ''
            raise RuntimeError(f'env_server からの応答がありません\n{err}')
        out = json.loads(line)
        if 'error' in out:
            raise RuntimeError(f"env_server エラー: {out['error']}\n{out.get('stack', '')}")
        return out

    def act(self, actions):
        out = self._rpc({'cmd': 'act', 'actions': [int(a) for a in actions]})
        self.requests = out['requests']
        self.results = out['results']
        return self.requests, self.results

    def stats(self):
        return self._rpc({'cmd': 'stats'})['stats']

    def close(self):
        try:
            self._rpc({'cmd': 'close'})
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass


# ══════════════════════════════════════════════════
# 方策ネットワーク
# ══════════════════════════════════════════════════

class PolicyNet(nn.Module):
    """共有トランク + 行動ヘッド3本 + 価値ヘッド。

    ヘッドを分けるのは、3種類の意思決定が同じ状況表現を共有しつつ
    別々の出力空間を持つため。合法手マスクは logits に -inf を足して掛ける。
    """

    def __init__(self, obs_dim, action_sizes, hidden=128):
        super().__init__()
        self.obs_dim = obs_dim
        self.action_sizes = dict(action_sizes)
        self.trunk = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.Tanh(),
            nn.Linear(hidden, hidden), nn.Tanh(),
        )
        self.heads = nn.ModuleDict({k: nn.Linear(hidden, action_sizes[k]) for k in HEADS})
        self.value = nn.Linear(hidden, 1)

        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.orthogonal_(m.weight, gain=np.sqrt(2))
                nn.init.zeros_(m.bias)
        for k in HEADS:                       # 出力層は小さめに（初期の暴走を避ける）
            nn.init.orthogonal_(self.heads[k].weight, gain=0.01)
        nn.init.orthogonal_(self.value.weight, gain=1.0)

    def forward(self, obs):
        h = self.trunk(obs)
        return {k: self.heads[k](h) for k in HEADS}, self.value(h).squeeze(-1)


class RunningNorm:
    """リターンの走査正規化。

    報酬は bb/hand で、オールインが絡むと ±100bb まで飛び、しかも分布の裾が重い。
    生の値を価値関数の教師にすると MSE が数百まで膨らんで方策側の勾配を押し流す
    （実測で 30 → 160 → 330 と発散した）。平均・分散を持ち回して単位分散に直すと、
    value_loss が 1 前後に落ち着き「学習が進んでいるか」を目で判断できるようになる。
    世代をまたいで持ち回さないと価値関数の較正がやり直しになるので、
    チェックポイントに一緒に保存する。
    """

    def __init__(self):
        self.mean, self.var, self.count = 0.0, 1.0, 1e-4

    def update(self, x):
        x = np.asarray(x, dtype=np.float64)
        if x.size == 0:
            return
        bm, bv, bc = float(x.mean()), float(x.var()), int(x.size)
        delta = bm - self.mean
        tot = self.count + bc
        self.mean += delta * bc / tot
        self.var = (self.var * self.count + bv * bc + delta ** 2 * self.count * bc / tot) / tot
        self.count = tot

    def normalize(self, x):
        return (np.asarray(x, dtype=np.float32) - self.mean) / float(np.sqrt(self.var) + 1e-8)

    def state(self):
        return {'mean': self.mean, 'var': self.var, 'count': self.count}

    def load(self, s):
        if not s:
            return
        self.mean, self.var, self.count = s['mean'], s['var'], s['count']


def masked_logits(logits, mask):
    """合法手以外を -inf にする。全部禁止になった行は素通し（環境側の保険）。"""
    mask = mask.bool()
    safe = mask.any(dim=-1, keepdim=True)
    mask = torch.where(safe, mask, torch.ones_like(mask))
    return logits.masked_fill(~mask, -1e9)


# ══════════════════════════════════════════════════
# ロールアウト
# ══════════════════════════════════════════════════

class Rollout:
    """決定点を貯め、ハンドが終わったら報酬を配って学習用テンソルにする。

    報酬はハンド終端でしか入らないので、同じ tid（env:hand:seat）の
    決定点すべてに同じリターンを配る。これが唯一の教師信号。
    """

    def __init__(self):
        self.by_tid = defaultdict(list)
        self.done = []

    def add(self, tid, sample):
        self.by_tid[tid].append(sample)

    def finish(self, tid, reward):
        items = self.by_tid.pop(tid, None)
        if not items:
            return 0
        for it in items:
            it['ret'] = reward
        self.done.extend(items)
        return len(items)

    def __len__(self):
        return len(self.done)

    def tensors(self):
        obs = torch.tensor(np.array([d['obs'] for d in self.done], dtype=np.float32))
        ret = torch.tensor(np.array([d['ret'] for d in self.done], dtype=np.float32))
        val = torch.tensor(np.array([d['val'] for d in self.done], dtype=np.float32))
        logp = torch.tensor(np.array([d['logp'] for d in self.done], dtype=np.float32))
        act = torch.tensor(np.array([d['act'] for d in self.done], dtype=np.int64))
        head = [d['head'] for d in self.done]
        masks = {}
        for k in HEADS:
            width = max((len(d['mask']) for d in self.done if d['head'] == k), default=1)
            m = np.zeros((len(self.done), width), dtype=np.float32)
            for i, d in enumerate(self.done):
                if d['head'] == k:
                    m[i, :len(d['mask'])] = d['mask']
            masks[k] = torch.tensor(m)
        head_idx = {k: torch.tensor([i for i, h in enumerate(head) if h == k], dtype=torch.long)
                    for k in HEADS}
        return obs, ret, val, logp, act, masks, head_idx


def _stack_masks(requests, idx, width):
    m = np.zeros((len(idx), width), dtype=np.float32)
    for j, i in enumerate(idx):
        mk = requests[i]['mask']
        m[j, :len(mk)] = mk
    return m


@torch.no_grad()
def choose(net, requests, greedy=False):
    """観測から行動を選ぶ。

    ヘッドごとにまとめて1回だけ torch を呼ぶ。1リクエストずつ回すと
    Python↔torch の往復がボトルネックになり、環境より10倍以上遅くなる。
    """
    if not requests:
        return [], [], []
    obs = torch.tensor(np.array([r['obs'] for r in requests], dtype=np.float32), device=DEVICE)
    logits_all, values = net(obs)

    n = len(requests)
    actions = np.zeros(n, dtype=np.int64)
    logps = np.zeros(n, dtype=np.float32)

    for head in HEADS:
        idx = [i for i, r in enumerate(requests) if r['head'] == head]
        if not idx:
            continue
        rows = torch.tensor(idx, dtype=torch.long, device=DEVICE)
        width = logits_all[head].shape[1]
        mask = torch.tensor(_stack_masks(requests, idx, width), device=DEVICE)
        lg = masked_logits(logits_all[head][rows], mask)
        dist = torch.distributions.Categorical(logits=lg)
        a = torch.argmax(lg, dim=-1) if greedy else dist.sample()
        actions[idx] = a.cpu().numpy()
        logps[idx] = dist.log_prob(a).cpu().numpy()

    return actions.tolist(), logps.tolist(), values.cpu().numpy().tolist()


def collect(net, env, target_decisions, gen, progress):
    """target_decisions 個の決定点が溜まるまで環境を回す。"""
    roll = Rollout()
    requests, results = env.requests, env.results
    steps = 0

    while len(roll) < target_decisions:
        actions, logps, vals = choose(net, requests)
        for r, a, lp, v in zip(requests, actions, logps, vals):
            roll.add(r['tid'], {'obs': r['obs'], 'act': a, 'logp': lp,
                                'val': v, 'head': r['head'], 'mask': r['mask']})
        requests, results = env.act(actions)
        for res in results:
            roll.finish(res['tid'], res['reward'])
        steps += len(actions)
        progress(steps, len(roll), target_decisions)

    env.requests, env.results = requests, results
    return roll, steps


# ══════════════════════════════════════════════════
# 評価
# ══════════════════════════════════════════════════

@torch.no_grad()
def evaluate(net, opponent, hands, tag):
    """席0を net、他席を opponent（None ならランダム）にして bb/hand を測る。

    自己対戦だけだと「自分だけ強くなったつもり」に陥る。
    固定の基準（ランダム / 過去最強）と必ず突き合わせる。
    """
    env = NodeEnv(envs=32, players=PLAYERS, level=LEVEL, seed=SEED + 9999)
    rng = np.random.default_rng(SEED + 4242)
    try:
        requests, _ = env.requests, env.results
        played = 0
        while played < hands:
            actions = [0] * len(requests)
            mine = [i for i, r in enumerate(requests) if r['seat'] == 0]
            theirs = [i for i, r in enumerate(requests) if r['seat'] != 0]

            if mine:
                a, _lp, _v = choose(net, [requests[i] for i in mine], greedy=True)
                for i, act in zip(mine, a):
                    actions[i] = act

            if theirs:
                if opponent is None:                      # ランダム相手
                    for i in theirs:
                        legal = [j for j, m in enumerate(requests[i]['mask']) if m]
                        actions[i] = int(rng.choice(legal))
                else:
                    a, _lp, _v = choose(opponent, [requests[i] for i in theirs], greedy=True)
                    for i, act in zip(theirs, a):
                        actions[i] = act

            requests, results = env.act(actions)
            played += sum(1 for x in results if x['seat'] == 0)
        st = env.stats()
        seat0 = st.get('seats', {}).get('0', {})
        return {
            f'bb_vs_{tag}': seat0.get('bb_per_hand', 0.0),
            f'win_vs_{tag}': seat0.get('win_rate', 0.0),
        }
    finally:
        env.close()


# ══════════════════════════════════════════════════
# ログ（trainer-contract 準拠）
# ══════════════════════════════════════════════════

def log_progress(episode, metrics):
    os.makedirs(_MODELS, exist_ok=True)
    logs = []
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, 'r', encoding='utf-8') as f:
                logs = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            logs = []                       # 壊れていたら捨てて続行（学習は止めない）
    logs.append({'episode': episode,
                 'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'), **metrics})
    logs = logs[-2000:]
    with open(LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(logs, f, indent=2, ensure_ascii=False)
    persist_data_file(LOG_FILE)


_last_progress = [0.0]


def make_progress(gen):
    """[Progress] 行。必ず改行で終える（\\r だとGUIに1文字も届かない）。
    出す間隔は時間ベース。刻みをステップ数にすると表示が固まって見える。"""
    def emit(step, done, total, force=False):
        now = time.time()
        if not force and now - _last_progress[0] < 0.5:
            return
        _last_progress[0] = now
        speed = done / max(1e-6, now - emit.t0)
        # Done/% は「決着したハンド数」を意味する枠なので、意味のない値を
        # 詰めるくらいなら出さない（正規表現側で任意項目になっている）。
        msg = f'[Progress] Gen {gen} | Step {done}/{total} | Speed: {speed:.1f}'
        if sys.stdout.isatty():
            sys.stdout.write('\r' + msg)
            sys.stdout.flush()
        else:
            print(msg, flush=True)
    emit.t0 = time.time()
    return emit


# ══════════════════════════════════════════════════
# 学習済み方策の書き出し（ブラウザで対戦するため）
# ══════════════════════════════════════════════════

def export_policy(net, obs_dim, path=POLICY_JSON):
    """js/ai-policy.js の NeuralPolicy が読む形にする。"""
    def layer(lin):
        return {'w': lin.weight.detach().cpu().tolist(),
                'b': lin.bias.detach().cpu().tolist()}

    data = {
        'obs_dim': obs_dim,
        'trunk': [layer(m) for m in net.trunk if isinstance(m, nn.Linear)],
        'heads': {k: layer(net.heads[k]) for k in HEADS},
        'meta': {'level': LEVEL, 'players': PLAYERS,
                 'exported': time.strftime('%Y-%m-%d %H:%M:%S')},
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f'✅ 学習済み方策を書き出しました: {os.path.relpath(path, _BASE)}', flush=True)


# ══════════════════════════════════════════════════
# PPO 更新
# ══════════════════════════════════════════════════

def update(net, opt, roll, retnorm):
    obs, ret_raw, val, logp_old, act, masks, head_idx = roll.tensors()
    retnorm.update(ret_raw.numpy())
    ret = torch.tensor(retnorm.normalize(ret_raw.numpy()))
    obs, ret, val, logp_old, act = [t.to(DEVICE) for t in (obs, ret, val, logp_old, act)]
    masks = {k: v.to(DEVICE) for k, v in masks.items()}
    head_idx = {k: v.to(DEVICE) for k, v in head_idx.items()}

    adv = ret - val
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)

    n = obs.shape[0]
    stats = {'loss': 0.0, 'kl': 0.0, 'entropy': 0.0, 'vloss': 0.0, 'n': 0}

    for _ in range(PPO_EPOCHS):
        perm = torch.randperm(n, device=DEVICE)
        for start in range(0, n, MINIBATCH):
            idx = perm[start:start + MINIBATCH]
            logits_all, values = net(obs[idx])

            logp = torch.zeros(len(idx), device=DEVICE)
            entropy = torch.zeros(len(idx), device=DEVICE)
            for k in HEADS:
                sel = torch.isin(idx, head_idx[k])
                if not sel.any():
                    continue
                rows = idx[sel]
                lg = masked_logits(logits_all[k][sel], masks[k][rows])
                dist = torch.distributions.Categorical(logits=lg)
                logp[sel] = dist.log_prob(act[rows])
                entropy[sel] = dist.entropy()

            ratio = torch.exp(logp - logp_old[idx])
            a = adv[idx]
            pg = -torch.min(ratio * a, torch.clamp(ratio, 1 - CLIP, 1 + CLIP) * a).mean()
            # ポーカーの収支は裾が重い。二乗誤差だと外れ値1本に引きずられるので Huber。
            vloss = F.smooth_l1_loss(values, ret[idx])
            ent = entropy.mean()
            loss = pg + VF_COEF * vloss - ENT_COEF * ent

            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), MAX_GRAD_NORM)
            opt.step()

            with torch.no_grad():
                kl = (logp_old[idx] - logp).mean()
            stats['loss'] += float(loss.item())
            stats['kl'] += float(kl.item())
            stats['entropy'] += float(ent.item())
            stats['vloss'] += float(vloss.item())
            stats['n'] += 1

    m = max(1, stats['n'])
    return {'loss': stats['loss'] / m, 'kl': stats['kl'] / m,
            'entropy': stats['entropy'] / m, 'value_loss': stats['vloss'] / m}


# ══════════════════════════════════════════════════
# メイン
# ══════════════════════════════════════════════════

def auto_num_envs():
    """未指定なら環境数を自動で決める。この環境はCPU依存（Node側）なので控えめに。"""
    if NUM_ENVS:
        return NUM_ENVS
    cpu = os.cpu_count() or 4
    return max(32, min(256, cpu * 16))


def run():
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    os.makedirs(_MODELS, exist_ok=True)
    recover_data_file(LOG_FILE)

    n_envs = auto_num_envs()
    print(f'▶ デバイス: {DEVICE} / 並列環境: {n_envs} / プレイヤー: {PLAYERS} / '
          f'認知レベル: {LEVEL}', flush=True)

    env = NodeEnv(envs=n_envs, players=PLAYERS, level=LEVEL, seed=SEED)
    print(f'▶ 観測次元: {env.obs_dim} / 行動: {env.action_sizes}', flush=True)

    net = PolicyNet(env.obs_dim, env.action_sizes).to(DEVICE)
    best = PolicyNet(env.obs_dim, env.action_sizes).to(DEVICE)
    retnorm = RunningNorm()

    start_gen = 1
    best_score = -1e9
    if os.path.exists(CKPT_FILE):
        ck = torch.load(CKPT_FILE, map_location=DEVICE)
        if ck.get('obs_dim') == env.obs_dim:
            net.load_state_dict(ck['state'])
            retnorm.load(ck.get('retnorm'))
            best_score = ck.get('best_score', -1e9)
            start_gen = ck.get('episode', 0) + 1
            print(f'▶ チェックポイントから再開: 世代 {start_gen}', flush=True)
        else:
            print('⚠️ 観測次元が変わっているのでチェックポイントを無視します', flush=True)

    if os.path.exists(BEST_FILE):
        bk = torch.load(BEST_FILE, map_location=DEVICE)
        if bk.get('obs_dim') == env.obs_dim:
            best.load_state_dict(bk['state'])
        else:
            best.load_state_dict(net.state_dict())
    else:
        best.load_state_dict(net.state_dict())

    opt = torch.optim.Adam(net.parameters(), lr=LR, eps=1e-5)

    try:
        for gen in range(start_gen, start_gen + MAX_GENS):
            t0 = time.time()
            progress = make_progress(gen)
            roll, steps = collect(net, env, DECISIONS_PER_GEN, gen, progress)
            progress(steps, len(roll), DECISIONS_PER_GEN, force=True)   # 最後は必ず出す
            if sys.stdout.isatty():
                print('', flush=True)

            train_stats = update(net, opt, roll, retnorm)
            env_stats = env.stats()
            dt = time.time() - t0

            metrics = {
                **{k: round(v, 6) for k, v in train_stats.items()},
                'fps': round(len(roll) / max(1e-6, dt), 1),
                'seconds_per_gen': round(dt, 1),
                'num_envs': n_envs,
                'games_finished': env_stats.get('hands', 0),
                'finish_rate': round(env_stats.get('finish_rate', 0), 4),
                'declare_accuracy': round(env_stats.get('declare_accuracy', 0), 4),
                'submit_rate': round(env_stats.get('submit_rate', 0), 4),
                'fold_rate': round(env_stats.get('fold_rate', 0), 4),
                'avg_slog': round(env_stats.get('avg_slog', 0), 4),
            }

            if gen % EVAL_EVERY == 0:
                metrics.update(evaluate(net, None, EVAL_HANDS, 'random'))
                metrics.update(evaluate(net, best, EVAL_HANDS, 'best'))
                # bb/hand が主指標。0 を上回れば過去最強より稼げている。
                metrics['bb_per_hand'] = metrics.get('bb_vs_best', 0.0)
                # 過去最強に対して bb/hand がプラス = 本当に上回った
                if metrics['bb_per_hand'] > 0:
                    best_score = metrics['bb_per_hand']
                    best.load_state_dict(net.state_dict())
                    torch.save({'state': net.state_dict(), 'obs_dim': env.obs_dim,
                                'episode': gen}, BEST_FILE)
                    export_policy(net, env.obs_dim)
                    print(f'🏆 過去最強を更新 (bb/hand={best_score:+.3f})', flush=True)

            torch.save({'state': net.state_dict(), 'obs_dim': env.obs_dim,
                        'episode': gen, 'retnorm': retnorm.state(),
                        'best_score': best_score}, CKPT_FILE)
            log_progress(gen, metrics)

            print(f"[Gen {gen}] loss: {metrics['loss']:.4f} kl: {metrics['kl']:.4f} "
                  f"entropy: {metrics['entropy']:.3f} fps: {metrics['fps']:.0f} "
                  f"finish_rate: {metrics['finish_rate']:.3f} "
                  f"declare_accuracy: {metrics['declare_accuracy']:.3f} "
                  f"({dt:.1f}s)", flush=True)
    finally:
        env.close()


if __name__ == '__main__':
    failed = False
    try:
        run()
    except KeyboardInterrupt:
        print('⏹️ 中断されました', flush=True)
    except Exception:
        traceback.print_exc()
        failed = True
    if failed:
        sys.exit(1)          # 例外を握りつぶして 0 で終わらない（GUIが成功と誤認する）
