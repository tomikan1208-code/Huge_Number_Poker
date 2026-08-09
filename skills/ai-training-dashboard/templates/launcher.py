"""
<アプリ名> — デスクトップアプリ版ランチャー
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
dashboard_server.py の Flask サーバーをバックグラウンドで起動し、
アドレスバーもタブもない独立ウィンドウで開く。見た目も操作感も
普通のWindowsアプリと同じになる。

ウィンドウの出し方は次の順で自動的に選ばれる:
  1. pywebview（インストールされていれば。ネイティブウィンドウ）
  2. Chrome / Edge のアプリモード（--app）※追加インストール不要
  3. 通常のブラウザ（最後の手段）

ウィンドウを閉じるとサーバーも終了する。
学習中に閉じた場合は「停止」ボタンと同じ扱いで学習も止まる
（train.py は世代ごとにチェックポイントを保存しているので、
  失われるのは進行中の1世代分だけ）。

使い方:
  python launcher.py           … コンソールあり（エラーを見たいとき）
  start_app.bat                … 同上
  MDD2コントロールパネル.vbs   … コンソールなし（アプリらしく起動）
"""

import os
import sys
import socket
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

_BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BASE)


def _ensure_streams():
    """pythonw.exe（コンソールなし）で起動したときの出力先を用意する。

    pythonw では sys.stdout / sys.stderr が None になるため、print() が
    AttributeError で落ちてプロセスが即死する（しかも画面に何も出ない）。
    ログファイルに逃がして、原因を後から追えるようにしておく。
    """
    log_path = None
    if sys.stdout is None or sys.stderr is None:
        log_dir = os.path.join(
            os.environ.get('LOCALAPPDATA', tempfile.gettempdir()), '<AppName>')
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, 'app.log')
        stream = open(log_path, 'a', encoding='utf-8', errors='replace', buffering=1)
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream
        print(f'\n===== {time.strftime("%Y-%m-%d %H:%M:%S")} 起動 =====')
    elif hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    return log_path


LOG_PATH = _ensure_streams()

from dashboard_server import app, manager  # noqa: E402

APP_TITLE = '<アプリ名>'
DEFAULT_PORT = 5556
WINDOW_SIZE = (1440, 940)


# ── ポート ────────────────────────────────────
def find_free_port(preferred=DEFAULT_PORT):
    """使えるポートを探す。既定ポートが埋まっていれば近くの空きを使う。

    注意: ここで SO_REUSEADDR を付けてはいけない。Windows では
    使用中のポートにも bind できてしまい（Linuxと挙動が違う）、
    既に別のサーバーが待ち受けているポートを「空き」と誤判定する。
    """
    for port in [preferred] + list(range(preferred + 1, preferred + 30)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    # 全滅したらOSに任せる
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


# ── サーバー ──────────────────────────────────
def start_server(port):
    """Flask をデーモンスレッドで起動する（ローカル専用なので127.0.0.1に限定）"""
    def run():
        app.run(host='127.0.0.1', port=port, debug=False,
                threaded=True, use_reloader=False)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def wait_until_ready(url, timeout=25.0):
    """サーバーが応答を返すまで待つ"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + '/api/status', timeout=1):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)
    return False


def shutdown(reason=''):
    """学習を止めてからプロセスごと終了する"""
    if manager.is_running:
        print('⏹️ 学習を停止しています...')
        manager.stop()
        for _ in range(60):          # 最大6秒だけ終了処理を待つ
            if not manager.is_running:
                break
            time.sleep(0.1)
    if reason:
        print(reason)
    # Flask がデーモンスレッドで動いているので即時終了させる
    os._exit(0)


# ── ウィンドウ: pywebview ──────────────────────
def open_with_pywebview(url):
    """pywebview があればネイティブウィンドウで開く"""
    try:
        import webview
    except ImportError:
        return False

    print('🪟 pywebview のネイティブウィンドウで開きます')
    window = webview.create_window(
        APP_TITLE, url,
        width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
        min_size=(960, 640),
    )

    def on_closed():
        shutdown('👋 ウィンドウが閉じられました')

    try:
        window.events.closed += on_closed
    except AttributeError:
        pass   # 古いバージョンでは webview.start() の戻りで処理する

    webview.start()
    shutdown('👋 ウィンドウが閉じられました')
    return True


# ── ウィンドウ: Chrome / Edge のアプリモード ────
def find_chromium_browser():
    """--app モードが使える Chromium 系ブラウザを探す"""
    candidates = []
    for var in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
        root = os.environ.get(var)
        if not root:
            continue
        candidates += [
            os.path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            os.path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            os.path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            os.path.join(root, 'Vivaldi', 'Application', 'vivaldi.exe'),
        ]
    for name in ('chrome', 'msedge', 'brave'):
        found = shutil.which(name)
        if found:
            candidates.append(found)

    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def open_with_app_mode(url):
    """Chrome/Edge の --app モードで、タブもアドレスバーもない窓を開く。

    専用の --user-data-dir を渡すのが重要:
      - 既存のブラウザに乗っ取られず、この起動が自前のウィンドウを持つ
        （＝ウィンドウを閉じたことをプロセス終了として検知できる）
      - 普段のブラウザのプロフィールを汚さない
      - ウィンドウの大きさや位置が次回も引き継がれる
    """
    browser = find_chromium_browser()
    if not browser:
        return False

    profile_dir = os.path.join(
        os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
        '<AppName>', 'window_profile')
    os.makedirs(profile_dir, exist_ok=True)

    cmd = [
        browser,
        '--app=' + url,
        '--user-data-dir=' + profile_dir,
        '--window-size={},{}'.format(*WINDOW_SIZE),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,TranslateUI',
    ]
    print(f'🪟 {os.path.basename(browser)} のアプリモードで開きます', flush=True)
    try:
        proc = subprocess.Popen(cmd)
    except OSError as e:
        print(f'⚠️ ブラウザの起動に失敗: {e}')
        return False

    proc.wait()   # ウィンドウが閉じられるまでここで待つ
    shutdown('👋 ウィンドウが閉じられました')
    return True


# ── ウィンドウ: 最後の手段 ─────────────────────
def open_with_default_browser(url):
    import webbrowser
    print('🪟 通常のブラウザで開きます（アプリウィンドウは使えませんでした）')
    webbrowser.open(url)
    print('   このウィンドウを閉じるか Ctrl+C でサーバーを終了します。')
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        shutdown('👋 終了します')


# ── メイン ────────────────────────────────────
def main():
    port = find_free_port(DEFAULT_PORT)
    url = f'http://127.0.0.1:{port}'

    print(f'\n  {APP_TITLE}')
    print(f'  {"─" * 46}')
    print(f'  サーバー: {url}')
    if LOG_PATH:
        print(f'  ログ: {LOG_PATH}')

    start_server(port)
    if not wait_until_ready(url):
        print('❌ サーバーの起動に失敗しました。')
        print('   python dashboard_server.py を直接実行してエラーを確認してください。')
        sys.exit(1)
    print('  準備完了\n', flush=True)

    if open_with_pywebview(url):
        return
    if open_with_app_mode(url):
        return
    open_with_default_browser(url)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        shutdown('👋 終了します')
