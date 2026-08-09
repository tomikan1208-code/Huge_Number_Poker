# 巨大数ポーカー（Huge Number Poker）

ポーカーの駆け引きと、配られたカードから数式を組んで**できるだけ大きい数**を作るパズルを
融合させたゲーム。答えは**自分で計算して入力**し、システムの計算値と一致しなければ失格になる。

7枚配られ、括弧を除いて5枚以下で数式を組む。`2` と `3` を並べて `23` にはできない。

---

## 動かす

```bash
npm install
npm start
```

→ http://localhost:3000

Windows なら `start.bat` をダブルクリックでも同じ（ポート掃除→依存確認→起動→ブラウザ）。

| 遊び方 | 入口 |
|---|---|
| CPU と対戦 / 1端末で複数人 | `index.html` → 「1端末で遊ぶ」 |
| インターネット対戦 | `online.html`（`share-internet.bat` で公開） |
| ソロ（スコアアタック） | `index.html` → 「ソロモード」 |

詳しい仕様・設計は **[PROJECT.md](PROJECT.md)**。

---

## CPU（AI）について

CPU は **人間と同じように計算を間違える**。

難しさは「答えの大きさ」ではなく**計算過程**で決まる。
たとえば `(4+6)^9 = 10^9` は `6^9 = 100777696` より値は大きいが、
前者は「1 のあとに 0 を 9 個」書くだけ、後者は 36→216→1296→… と
中間結果を作業記憶に載せたまま多桁の乗算を繰り返す必要がある。

| 式 | 値 | 上級CPUの正答率 |
|---|---|---|
| `(4+6)^9` | 10億 | **0.92** |
| `6^9` | 約1億 | **0.52** |

さらに**計算に使える時間はポットのチップ数**で決まるので、
ベット額を上げると自分の正答率も上がる。CPU はそれも織り込んでベット額を決める。

CPU の強さは5段階（見習い / 常連 / 計算屋 / 暗算名人 / グランドマスター）。
作業記憶の容量・処理速度・ストレス耐性・知っている事実（九九、階乗、log表）が違う。

---

## AI を学習させる

方策（ベット・式の選び方・交換）を PPO で自己対戦学習する。
**正答率のモデルは学習しない**（人間を模した固定の物理法則として扱う。
学習させると「間違えないAI」に収束してゲームが成立しなくなる）。

```bash
python train/launcher.py        # GUI（開始/停止・グラフ・表）
```

GUI を使わず直接回すなら:

```bash
python train/train.py
```

環境（ゲームのルールと巨大数エンジン）は **Node 側**が持ち、Python は学習だけを行う。
巨大数エンジンを Python に書き直すとルールが二重管理になるため、
`js/engine.js` を唯一の正としたまま stdin/stdout の NDJSON で繋いでいる。

環境変数で設定を渡す:

| 変数 | 意味 | 既定 |
|---|---|---|
| `HNP_MAX_GENS` | 何世代回すか | 30 |
| `HNP_NUM_ENVS` | 並列する卓の数 | 自動 |
| `HNP_DECISIONS` | 1世代で集める意思決定の数 | 8192 |
| `HNP_LEVEL` | 相手にする「人間」の計算力 | skilled |

環境だけの動作確認:

```bash
node train/env_server.js --selfplay 300 --level skilled
```

学習した重みは `models/policy_<レベル>.json` に出る。
ゲーム側が自動で読み、そのレベルの CPU が学習済みの打ち方をする
（無ければヒューリスティック方策で動くので、学習しなくても遊べる）。

---

## 出先で続きをやる

**Colab で学習する場合**は `train/colab_train.ipynb` を開いて上から実行するだけ。
スマホでファイルをダウンロードして Drive に移す必要はない（Colab から直接 clone できる）。

学習ログは Drive の `huge_number_poker_checkpoints/` に自動で写るので、
手元に戻ってから GUI で推移を見られる。

---

## ファイル構成

```
index.html / online.html      画面
server.js                     Express + Socket.io（オンライン対戦）
js/
  engine.js                   巨大数エンジン（HugeNumber / パーサ / 評価・判定）
  game.js                     ゲーム進行（状態機械・ベット・精算）
  builder.js                  D&D の数式ビルダー
  ui.js / online-*.js         画面制御
  ai-cognition.js             人間の計算難易度 → 正答率のモデル
  ai.js                       数式の全数列挙・申告生成・ヒューリスティック方策
  ai-policy.js                観測（特徴量）の定義と学習済み方策の推論
train/
  env_server.js               並列環境サーバー（Node）
  train.py                    PPO 学習器（Python）
  dashboard_server.py         学習ダッシュボード（Flask + SSE）
  launcher.py                 デスクトップアプリとして起動
  colab_train.ipynb           Colab 用ノートブック
models/policy_*.json          学習済みの重み（ゲームが読む）
skills/                       学習ダッシュボードのスキル定義（バックアップ）
```
