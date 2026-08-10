"""
巨大数ポーカーAI学習 — デスクトップアプリ版ランチャー
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

使い方（いずれもリポジトリ直下から）:
  AI学習コントロールパネル.vbs   … コンソールなし。普段はこれ
                                   （右クリック→ショートカット作成でデスクトップに置ける）
  AI学習コントロールパネル.bat   … コンソールあり。起動しないときの原因を見る用
  python train/launcher.py       … 同上
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

# %LOCALAPPDATA% の下に作るフォルダ名。ログとブラウザのプロフィールを置く。
# テンプレートの <AppName> のままにしておくと、Windows はファイル名に
# < と > を使えないので os.makedirs が WinError 123 で落ちる。
APP_DIR = 'HugeNumberPokerAI'

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
            os.environ.get('LOCALAPPDATA', tempfile.gettempdir()), APP_DIR)
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


def _message_box(title, text):
    """コンソールが無くても見えるように、Windows のダイアログで知らせる。

    .vbs（pythonw）から起動されると標準出力はどこにも出ない。
    依存パッケージが無いだけなのに「ダブルクリックしても何も起きない」に
    見えてしまうので、ここだけは必ず画面に出す。
    """
    print(f'{title}: {text}', flush=True)
    if os.name != 'nt':
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)   # MB_ICONERROR
    except Exception:
        pass


def _scan_dependencies():
    """何が足りないかを調べる。(致命的に足りないもの, 学習に足りないもの)"""
    missing_fatal, missing_train = [], []

    for mod in ['flask']:
        try:
            __import__(mod)
        except ImportError:
            missing_fatal.append(mod)

    for mod in ['torch', 'numpy']:
        try:
            __import__(mod)
        except ImportError:
            missing_train.append(mod)

    if not shutil.which('node'):
        missing_train.append('Node.js（環境サーバーに必要）')

    return missing_fatal, missing_train


def check_dependencies_console():
    """コンソールから起動されたとき用。足りなければその場で入れられるようにする。

    もとは .bat 側でやっていたが、日本語を含む UTF-8 の .bat は
    `chcp 65001` と噛み合わず、cmd がファイル位置を見失って
    **行の途中から実行してしまう**（実際に文字化けして落ちた）。
    文字を出す仕事はすべて Python に寄せ、.bat は ASCII だけにした。
    """
    print(f'\n  {APP_TITLE} コントロールパネル')
    print(f'  {"─" * 46}')
    print('  普段は「AI学習コントロールパネル.vbs」を使ってください。')
    print('  （コンソールが出ず、アプリらしく開きます）')
    print('  こちらは起動しないときに原因を見るためのものです。\n')

    missing_fatal, missing_train = _scan_dependencies()
    missing_pip = [m for m in missing_fatal + missing_train if not m.startswith('Node')]
    needs_node = any(m.startswith('Node') for m in missing_train)

    if not missing_fatal and not missing_train:
        print('  依存パッケージ: すべて揃っています\n')
        return

    print(f'  足りないもの: {", ".join(missing_fatal + missing_train)}\n')

    if missing_pip:
        req = os.path.join(_BASE, 'requirements.txt')
        try:
            answer = input('  いま pip で入れますか？ [Y/n]: ').strip().lower()
        except EOFError:
            answer = 'n'
        if answer != 'n':
            print()
            subprocess.call([sys.executable, '-m', 'pip', 'install', '-r', req])
            print()
            missing_fatal, missing_train = _scan_dependencies()

    if needs_node:
        print('  [注意] Node.js が見つかりません。')
        print('         環境（ゲームのルール）は Node 側にあるので、')
        print('         これが無いと学習を開始できません。')
        print('         https://nodejs.org/ からインストールしてください。\n')

    if missing_fatal:
        print('  flask がまだ入っていないので画面を出せません。終了します。')
        sys.exit(1)


def check_dependencies():
    """起動前に必要なものが揃っているか確かめる（ダイアログ版）。

    .vbs から起動されるとコンソールが無いので、足りないことを
    画面に出さないと「ダブルクリックしても無反応」に見えてしまう。
    """
    missing_fatal, missing_train = _scan_dependencies()

    if missing_fatal:
        _message_box(
            f'{APP_TITLE} — 起動できません',
            '次のパッケージが入っていません:\n\n'
            f'    {", ".join(missing_fatal)}\n\n'
            'コマンドプロンプトで次を実行してください:\n\n'
            '    pip install -r train/requirements.txt\n\n'
            'コンソール付きで原因を見るなら\n'
            '「AI学習コントロールパネル.bat」を実行してください。'
        )
        sys.exit(1)

    if missing_train:
        _message_box(
            f'{APP_TITLE} — 学習は開始できません',
            '画面は開きますが、次が入っていないので学習を開始できません:\n\n'
            f'    {", ".join(missing_train)}\n\n'
            '過去の学習ログを見るだけならこのまま使えます。\n\n'
            '学習もするなら:\n'
            '    pip install -r train/requirements.txt\n'
            '    （Node.js は https://nodejs.org/ から）'
        )

    return missing_train


APP_TITLE = '巨大数ポーカーAI学習'

# --console … .bat から呼ばれたとき。コンソールに日本語で案内し、
#             足りない依存はその場で入れられるようにする。
# それ以外 … .vbs から呼ばれたとき。コンソールが無いのでダイアログで知らせる。
if '--console' in sys.argv:
    check_dependencies_console()
else:
    check_dependencies()

from dashboard_server import app, manager  # noqa: E402

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

    # プロフィール置き場を作れなくても、窓を開くこと自体は諦めない。
    # ここで例外を投げると「サーバーは動いているのに画面が出ない」という
    # 一番わかりにくい壊れ方になる（実際にそうなった）。
    profile_dir = os.path.join(
        os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
        APP_DIR, 'window_profile')
    try:
        os.makedirs(profile_dir, exist_ok=True)
    except OSError as e:
        print(f'⚠️ プロフィール置き場を作れません: {e}')
        return False

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

    # 窓の開き方は上から順に試す。途中で何が起きても、
    # 最後は通常のブラウザで必ず開けるようにしておく。
    # ここで例外を素通しすると「サーバーは動いているのに画面が出ない」
    # という一番わかりにくい壊れ方になる。
    for opener in (open_with_pywebview, open_with_app_mode):
        try:
            if opener(url):
                return
        except Exception as e:
            print(f'⚠️ {opener.__name__} が失敗しました（次の方法を試します）: {e}')

    open_with_default_browser(url)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        shutdown('👋 終了します')
