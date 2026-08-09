# Colab ⇄ ローカルの連携

Colabで回した学習の結果を、手元のGUIで見られるようにする。

## 前提として最初に確認すること

Colabのノートブックが**どこでコードを実行しているか**を必ず確認する。
よくある構成は「Drive上のコードを `/content` にコピーして実行」で、この場合:

- `/content` は**ランタイム切断で消える**
- **Driveのコードを更新しない限り、Colabは古いコードのまま動く**

後者は見落としやすい。ローカルで直しても Colab には反映されない。

## ① 学習ログを永続フォルダに残す（最重要）

チェックポイント(.pth)だけ保存してログを忘れている実装が多い。
**グラフの元データはログの方**なので、これが無いと世代ごとの推移が毎回消える。

```python
DRIVE_DATA_DIR = '/content/drive/MyDrive/<プロジェクト名>_checkpoints'
_LOCAL_BASE = os.path.join(os.path.dirname(__file__), 'models')

def _effective_dir():
    """Colabなら Drive、ローカルなら models/ を返す"""
    return DRIVE_DATA_DIR if os.path.isdir(DRIVE_DATA_DIR) else _LOCAL_BASE

def persist_data_file(local_path):
    """保存時に呼ぶ。永続フォルダへコピー"""
    dest = os.path.join(_effective_dir(), os.path.basename(local_path))
    if os.path.abspath(local_path) == os.path.abspath(dest):
        return                                    # ローカルでは同一なので何もしない
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(local_path, dest)

def recover_data_file(local_path):
    """起動時に呼ぶ。永続フォルダの方を正本として復元"""
    src = os.path.join(_effective_dir(), os.path.basename(local_path))
    if os.path.abspath(local_path) == os.path.abspath(src):
        return
    if os.path.exists(src):
        shutil.copy2(src, local_path)
```

同一パスを弾く判定を入れておくと、**ローカル実行では自動的に何もしない**ので分岐が要らない。

対象: 学習ログJSON、集団情報、設定JSON。チェックポイント(.pth)は別途。

## ② ローカルへ取り込む

`google-api-python-client` + `google-auth-oauthlib` で Drive から落とす。

**スコープは `drive` が必要。** `drive.file` は「このアプリが作ったファイル」しか見えず、
Colabが作ったファイルを読めない。

**取り込み先は別フォルダにする。** ローカルの `models/` を直接上書きしない。

```
models/       ← ローカルの学習結果（触らない）
colab_data/   ← Driveから取り込んだもの
```

そのうえでGUIに表示切替を用意する。

| 選択 | 表示するもの |
|---|---|
| ローカル | `models/` |
| Colab | `colab_data/` |
| 統合 | 世代番号で突き合わせ、同じ世代なら記録が充実している方を採用 |

両方で同時に学習を進めると世代番号が衝突する。**どちらか一方で進める**のが安全。

## ③ 送る側は上書き事故に注意

ローカル → Drive のアップロードは**同名ファイルを上書き**する。
Colabで先に学習を進めていた場合、その記録が消える。**必ず確認を挟む。**

送り先は用途で分ける。

| 内容 | 送り先 |
|---|---|
| 学習ログ・集団情報・設定 | データフォルダ（`*_checkpoints`） |
| コード（.py） | **コードフォルダ**（ノートブックがコピー元にしている場所） |

コードを送る機能を付けると「ローカルで直す → ボタン1つでColabに反映」が回るようになる。
ただし **`.env` / `credentials.json` / トークンは絶対に送らない**（除外リストを明示的に持つ）。
GUI専用のファイル（サーバー・ランチャー）も送る必要がない。

## OAuth設定でつまづく点

利用者に必ず伝える。

1. Google Cloud Console で **Drive API を有効化**
2. OAuthクライアントIDを **「デスクトップアプリ」** 種別で作成し `credentials.json` として配置
3. **OAuth同意画面の「テストユーザー」に自分のアカウントを追加**
   → 忘れると作成者本人でも `403 access_denied` で弾かれる。**最頻の詰まりどころ**
4. 「確認されていないアプリ」の警告は「詳細」→「移動」で進む（自作アプリなので正常）

**テスト状態のアプリはトークンが7日で失効する。** 週1回つなぎ直しが必要になる旨を伝えておく。
本番公開は制限付きスコープの審査が必要で、個人利用ではかえって手間。
