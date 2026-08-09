# デスクトップアプリとして起動する

ブラウザのタブではなく、独立したウィンドウで開く。追加インストールは不要。

## 仕組み

サーバーを裏で起動し、次の順で窓を開く。

1. `pywebview`（入っていればネイティブウィンドウ）
2. **Chrome / Edge のアプリモード**（`--app=`）← 追加インストール不要。通常はこれ
3. 通常のブラウザ（最後の手段）

アプリモードは**専用の `--user-data-dir` を渡すのが要**。

```python
cmd = [browser, f'--app={url}', f'--user-data-dir={profile_dir}',
       '--window-size=1440,940', '--no-first-run', '--no-default-browser-check']
proc = subprocess.Popen(cmd)
proc.wait()          # ウィンドウが閉じられるまで待つ
shutdown()           # 閉じたらサーバーも終了
```

専用プロファイルにすることで:

- 既存のブラウザに乗っ取られず、この起動が自前のウィンドウを持つ
  （＝ `proc.wait()` で「閉じられた」を検知できる）
- 普段のブラウザのプロフィールを汚さない
- ウィンドウの大きさ・位置が次回も引き継がれる

タブもアドレスバーも出ないので、見た目は普通のアプリになる。
タスクバーのアイコンはページの favicon が使われるので、`icon.svg` を用意しておく。

## コンソールを出さずに起動する（Windows）

`.vbs` から `pythonw.exe` を呼ぶ。右クリック→ショートカット作成でデスクトップに置ける。

```vbs
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir
shell.Run "pythonw.exe """ & baseDir & "\app.py""", 0, False
```

**`.vbs` は UTF-16LE(BOM付き) で保存する。** UTF-8だとWindows Script Hostが
ANSIとして読み、日本語コメントの文字化けが次の行を巻き込む。エラーも出ずに何も起動しない。

**`pythonw` では `sys.stdout` が `None` になり得る。** `print()` が例外で即死し、画面には
何も出ない。起動直後にログファイルへ逃がす。

```python
if sys.stdout is None or sys.stderr is None:
    path = os.path.join(os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
                        '<アプリ名>', 'app.log')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stream = open(path, 'a', encoding='utf-8', errors='replace', buffering=1)
    sys.stdout = sys.stdout or stream
    sys.stderr = sys.stderr or stream
```

コンソール付きの `.bat` も併せて用意しておくと、起動しないときの原因が見える。

## 空きポートの判定

```python
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    try:
        sock.bind(('127.0.0.1', port))     # SO_REUSEADDR は付けない
        return port
    except OSError:
        continue
```

**Windowsでは `SO_REUSEADDR` を付けると使用中のポートにも bind できてしまう**（Linuxと逆）。
既に別のサーバーがいるポートを「空き」と誤判定して二重起動する。

## 終了時の扱い

ウィンドウを閉じたらサーバーも終了する。学習中なら停止するかを決めて**利用者に明示する**。
チェックポイントを毎世代保存していれば失うのは進行中の1世代分だけ、と説明できる。

## exe化について

**あまり得をしない。** PyTorch(数GB)は現実的に同梱できないので、exeにしても学習には
実機のPython環境が必要になる。「配布用の1ファイル」にはならず、`.vbs` のショートカットと
体感は変わらない。

作る場合は `sys.executable` の扱いに注意。凍結後は exe 自身を指すため、
子プロセス起動が「学習の代わりにGUIが再起動」になる。

```python
def python_exe():
    if getattr(sys, 'frozen', False):
        return (os.environ.get('<PREFIX>_PYTHON')
                or shutil.which('python') or shutil.which('py') or 'python')
    return sys.executable
```
