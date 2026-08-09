# 学習スクリプトが満たすべき取り決め

GUIは学習スクリプトの中身を知らない。この2つの窓口だけで会話する。
**学習ロジックには触らず、出力の形だけを整える。**

## ① 世代ごとのJSONログ（グラフ・表の正）

1世代終わるごとに、配列へ1件追記する。

```json
[
  {"episode": 1, "timestamp": "2026-08-09 21:23:37", "loss": 0.0213, "kl": 0.0288,
   "fps": 26531.8, "win_vs_random": 0.896},
  {"episode": 2, "timestamp": "2026-08-09 21:25:28", "loss": 0.0198, "kl": 0.0281}
]
```

**決まり**

- `episode` と `timestamp` は必須。他は任意（無い世代は欠けていてよい）
- 評価が10世代ごとなど**まばらでもよい**。GUI側は欠損として扱う
- 勝率は **0〜1 に正規化**して入れる（`%` と混在させない。単位の混在は事故のもと）
- 件数の上限を決めて古い順に捨てる（例: 直近2000世代）
- **書いた直後に永続フォルダへコピーする**（Colab対策。`colab-sync.md`）

書き込み例:

```python
def log_progress(self, episode, metrics):
    log_file = os.path.join(self.save_dir, f"{self.model_name}_log.json")
    logs = []
    if os.path.exists(log_file):
        try:
            with open(log_file, "r", encoding="utf-8") as f:
                logs = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            logs = []          # 壊れていたら捨てて続行（学習を止めない）
    logs.append({"episode": episode,
                 "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"), **metrics})
    logs = logs[-2000:]
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(logs, f, indent=2, ensure_ascii=False)
    persist_data_file(log_file)     # 永続フォルダへ
```

`encoding="utf-8"` と `ensure_ascii=False` を省かないこと。日本語のラベルが入ると
Windows既定の cp932 で落ちる。

## ② 標準出力の進捗行（ライブ表示）

JSONに書かれるのは世代が終わってから。**その間の数十秒〜数分を埋める**ための1行。

```
[Progress] Gen 6 | Step 126/300 | Done: 4210/10000 (42.1%) | Speed: 19842 steps/s
```

**決まり**

- **必ず改行で終える。`\r` で上書きしない。**
  パイプで読むGUIは行単位で受け取るため、`\r` だと世代が終わるまで1文字も届かない
- ターミナルでの見栄えを保ちたい場合は出し分ける:

```python
if sys.stdout.isatty():
    sys.stdout.write("\r" + msg); sys.stdout.flush()   # 人が見るとき
else:
    print(msg, flush=True)                              # GUIが読むとき
```

- **今どの世代か**を必ず入れる。無いとGUIは「学習中の世代」を出せない
- 出す間隔は**時間ベース**（0.5秒ごと等）。ステップ数刻みだと、刻みを過ぎたあと
  表示が止まって見える（`100/120` のまま固まる、など）
- **最後のステップは必ず出す**（`step == max_steps - 1` を条件に足す）
- 更新頻度のコストは気にしなくてよい。1回の同期は数十µsで、多くの学習ループは
  既に毎ステップ同期している（`alive.any()` など）。実測で1世代の0.02%程度

## ③ 終了コード

**例外を握りつぶして終了コード0で終わらせない。** GUIも自動改善ループも、
戻り値で成否を判断する。0を返すと「成功したが指標が変わらない」と誤認され、
壊れた設定のまま延々と空回りする。

```python
failed = False
try:
    run_training_loop()
except Exception:
    traceback.print_exc()
    failed = True
if failed:
    sys.exit(1)
```

## ④ 設定の受け渡しは環境変数で

GUIから学習スクリプトへ渡す値は環境変数にする（コマンド引数を増やすより壊れにくく、
Colabのノートブックからも同じ手が使える）。

| 変数 | 意味 |
|---|---|
| `<PREFIX>_MAX_GENS` | 何世代回すか |
| `<PREFIX>_NUM_ENVS` | 並列環境数（未指定ならVRAMから自動判定） |

環境数のような性能パラメータは、**未指定ならGPUのVRAMから自動で決める**とローカルとColabで
同じコードが使える。実測に基づく目安（VRAMの45〜50%に収める）:

| VRAM | 並列環境数 |
|---|---|
| 8GB（RTX 3050等） | 10000 |
| 16GB（Colab T4/V100） | 16384 |
| 24GB（L4） | 20480 |
| 40GB（A100） | 32768 |
| CPUのみ | 512 |

環境数を5倍にしてもステップ時間は3割弱しか増えない（GPUが遊んでいるため）。
**VRAMが許す範囲で多いほど効率がよい。**
