# テンプレートの使い方

そのままコピーして使える。ゲーム固有の部分だけ読み替える。

## コピーの仕方

```
コピー先/
  dashboard_server.py   ← 「■ プロジェクト設定」だけ書き換える
  launcher.py           ← <アプリ名> を置換
  web/
    index.html  app.js  app.css  chart.js  icon.svg   ← そのまま
```

| ファイル | 書き換え |
|---|---|
| `dashboard_server.py` | **冒頭の設定ブロックだけ。** 指標をここで定義すれば画面・表・グラフが自動追従する |
| `index.html` `app.js` | **不要。** 指標は `/api/config` から受け取る |
| `chart.js` | **不要。** 依存ゼロのSVG折れ線。縦軸1本のみ（2軸は作れない） |
| `app.css` | **不要。** モノクロのデザイン一式 |
| `launcher.py` | `<アプリ名>` を置換 |

### 検証済み

オセロ想定（指標7つ: 勝率2種・Loss・KL・fps・平均石差・角の獲得率）で、
**設定ブロックの書き換えだけ**でタイル10枚・世代表・グラフ7枚が生成されることを確認済み。
フロントエンドは一行も触っていない。

## chart.js

```js
MDDChart.renderLegend(document.getElementById('legend'), series);   // 2系列以上のときだけ
MDDChart.render(document.getElementById('box'), {
    height: 260, xLabel: '世代', xMin: 1, xMax: 500,
    series: [
        { key: 'win_vs_random', label: 'vs Random', points: [{x:10,y:89.6}, ...],
          dash: false, tipFormat: v => v.toFixed(1) + '%' },
        { key: 'win_vs_best', label: 'vs Best', points: [...], dash: true },
    ],
    axes: { left: { label: '勝率 (%)', min: 0, max: 100, format: v => v.toFixed(0) + '%' } },
    emptyText: 'まだ評価が記録されていません。'
});
```

- 系列の区別は**実線／破線**。色は使わない
- 評価がまばら（10世代ごと等）でも、`xMin` / `xMax` を渡せば他のグラフと横軸が揃う
- 1系列のときは凡例を出さない（見出しが系列名を兼ねる）
- **3系列以上は小さなグラフを並べる。** 同じ `axes` を渡せば高さを直接比べられる

## app.css

主なクラス。ゲーム固有の名前（`.deck-*` / `.island-*`）は読み替える。

| クラス | 用途 |
|---|---|
| `.tiles` / `.tile` | 現在値のタイル |
| `.card` / `.card-head` | 枠 |
| `.filter-row` | グラフ共通のフィルタ行（**グラフの中に置かない**） |
| `.small-multiples` / `.sm-item` | 小さなグラフを並べる |
| `.chart-box` / `.chart-legend` | グラフ本体と凡例 |
| `.meter-track` / `.meter-fill` | 勝率バー |
| `.step-bar` | 世代内のステップ進捗 |
| `.segmented` | タブ |
| `.panel` | 設定のスライドパネル |

配色は白・黒・グレーのみ。`--ink`（濃）〜`--ink4`（淡）と `--line` / `--track` を使う。
グラデーションと影は使わない。

## launcher.py

```bash
python launcher.py
```

`dashboard_server.py` の Flask アプリ（`app`）と、学習プロセス管理（`manager`）を
import している前提。名前が違う場合は冒頭の import を直す。
