# 図面AR（試作）

紙の図面にスマホをかざすと、対応する3Dモデル・資料情報・アノテーションが出る静的サイト。
サーバー処理なし。ライブラリはすべて `lib/` に同梱し、外部への通信はしない。

## 構成

```
index.html          一覧（QRの飛び先にもできる）
ar.html             AR表示（?id=資料ID を付けるとそのモデルを先読みする）
viewer.html         通常の3D表示（認識できないとき・カメラが使えないときの逃げ先）
tools/              管理用：認識用データの作成、QRコード
data/items.json     台帳（図面1枚＝1件）
data/<id>/          model.glb / meta.json / annotations.json
targets/all.mind    認識用データ（全図面をまとめた1ファイル）
targets/src/        認識用データの元になる図面画像
lib/ js/ css/       同梱ライブラリと本体
```

本体のうち追跡に関わるもの：`js/tracking.js`（MindAR の追跡処理の差し替え）、
`js/stabilizer.js`（表示の揺れ止めと、見失ったときの固定表示）、
`tools/trackpoints.js`（追跡用の手がかりの選び直し）。

## 公開（GitHub Pages）

1. このフォルダの中身をリポジトリの最上位に置いて push する。
2. Settings → Pages → Branch を `main` / `(root)` にする。
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` で開く。

カメラは HTTPS でしか動かない。PCでの確認は、このフォルダで `python -m http.server` を実行し
`http://localhost:8000/` を開く。スマホ実機での確認は Pages に上げてから行う。

`targets/src/` の図面画像は認識用データを作るときにだけ使い、公開サイトの表示には使わない。
権利の確認が取れていない図版は、リポジトリに入れずに手元だけに置く。

## 図面を追加する

1. モデルを軽くする（目安：テクスチャ 2048px 以下、5MB 前後）。
   `npx @gltf-transform/cli resize in.glb a.glb --width 2048 --height 2048`
   `npx @gltf-transform/cli draco a.glb model.glb`
2. `data/<id>/` に `model.glb`、`meta.json`、`annotations.json` を置く。
3. 図面画像を `targets/src/<id>.jpg` に置く。**印刷するものと同じ画像**を使う。
4. `data/items.json` に1件足す。`targetIndex` は 0 から順に重複なく振る。
5. `tools/` を開き「作成する」→ 保存した `all.mind` を `targets/all.mind` に置き換える。
6. 同じページでQRコードを作り、図面に添えて印刷する。

印刷後に変えられないもの：公開URL（QRに入る）と図面画像（変えると配布済みの紙が反応しなくなる）。

## 台帳（data/items.json）

| 項目 | 内容 |
|---|---|
| `id` | 資料ID。URLとフォルダ名に使う |
| `targetIndex` | `all.mind` の中での順番（0始まり） |
| `target.source` | 図面画像の場所 |
| `target.widthPx` / `heightPx` | 図面画像の画素数。置き場所の計算に使う |
| `target.printWidthMm` | 印刷した図面の幅（mm）。縮尺を合わせるときだけ必要 |
| `model.src` | モデルの場所 |
| `model.rotationDeg` | 向きの補正 `[x, y, z]`（度）。上が +Y になるようにする |
| `model.metersPerUnit` | モデルの1単位が何mか。縮尺を合わせるときだけ必要 |
| `display.mode` | `stand`＝紙の上に立たせる／`lay`＝図に重ねて寝かせる |
| `display.anchor` | 置き場所。図面の左上が `[0,0]`、右下が `[1,1]` |
| `display.size` | `{"type":"fit","value":0.35}`＝図面幅の35%の大きさで出す／`{"type":"scale","value":0.3333}`＝図面と同じ縮尺（この例は1/3）で出す |
| `meta` / `annotations` | それぞれのJSONの場所（省略可） |

`site.title` と `site.lead` は一覧の見出し。

## 追跡の調整

モデルが揺れる・消えるときは、まず `ar.html?debug=1` で開いて画面左上の数字を見る。

| 表示 | 見方 |
|---|---|
| 認識 n回/秒 | 追跡処理の速さ。10を下回ると動きに追いつけず見失いやすい |
| 手がかり n点 | そのコマで図面と合った目印の数。6点未満のコマは姿勢の更新に使わない |
| 発見（一部 a/b） | 図面を探して見つけた回数。a/b は成功回数／試した回数。b ばかり増えるなら探す段階でつまずいている |
| 却下 | 見つけた直後に追跡へ移れず、探し直した回数 |
| 探し直し / 見失い | 追跡をあきらめて図面を探し直した回数／表示を固定に切り替えた回数 |
| 作り直し | 追跡の処理が止まったのを検知して、自動で作り直した回数 |
| エラー | 追跡の処理で出た例外の数と、最後の内容 |
| 映像 | カメラ映像の画素数 |

設定は台帳の最上位に `"tracking": { ... }` を足すと変えられる。同じ名前をURLに付けて
試すこともできる（例 `ar.html?debug=1&stillCutoff=0.3`）。

| 項目 | 既定 | 内容 |
|---|---|---|
| `stillCutoff` | 0.5 | 手を止めているときの揺れ止めの強さ。小さいほど揺れないが、動き出しが遅れる |
| `posFollow` / `rotFollow` | 15 / 7 | 動かしたときに追従を速める度合い（位置／向き）。大きいほど遅れないが揺れが残る |
| `hold` | 1 | 1＝見失っても最後の姿勢で表示を残す。0＝消す |
| `lostAfterMs` | 800 | 姿勢が得られない状態が何ミリ秒続いたら「見失った」とするか |
| `minPoints` | 6 | 姿勢の更新に使う手がかりの最少数 |
| `retryFrames` | 8 | 追跡に失敗しても、図面の探し直しに戻らず粘るコマ数 |
| `rejectOutliers` | 1 | 1＝周りと食い違う手がかりを姿勢の計算から外す |
| `detectMode` | 0 | 図面の探し方。0＝画面の一部を順に見る（MindAR既定）、1＝画面全体を縮めて見る、2＝交互。擬似映像では成功率に差がなかった |
| `warmupTolerance` | 2 | 表示を始めるまでに必要な連続成功コマ数 |
| `cameraLongSide` | 0 | カメラ映像の長辺の希望画素数（0＝ブラウザ任せ）。実機では未確認 |

### 見失ったとき

画面に「図面を見失いました」と出ている間、モデルは最後の位置のまま画面に残る。
図面を画面いっぱいに映し直すと自動で追跡に戻る。戻らないときは「探し直す」を押すと、
カメラと追跡を作り直す（ページの再読み込みは不要）。

図面は近いほど見つけやすい。擬似映像での1回あたりの成功率は、図面が画面からはみ出す近さで約9割、
画面幅の8割で約6割、画面幅の半分で約3割だった。

## 資料情報（meta.json）

```json
{ "title": "表示名", "fields": [ { "label": "遺跡名", "value": "" } ], "notice": "" }
```

`value` が空の項目は画面に出ない。

## アノテーション（annotations.json）

レイヤー単位で `uid`・`Annotation_Type`（Point / Line / Area）・`metadata` を持つ。
座標は **GLBを読み込んだときの座標**（`rotationDeg` をかける前）。

```json
{
  "coordinate": "glb",
  "layers": [
    { "uid": "…", "name": "Point_001", "Annotation_Type": "Point", "color": "#ff3b30",
      "metadata": { "内容": "…" },
      "items": [ { "label": "1", "note": "…", "position": [x, y, z] } ] },
    { "uid": "…", "name": "Line_001", "Annotation_Type": "Line",
      "items": [ { "points": [[x, y, z], [x, y, z]] } ] },
    { "uid": "…", "name": "Area_001", "Annotation_Type": "Area",
      "items": [ { "points": [[x, y, z], [x, y, z], [x, y, z]] } ] }
  ]
}
```

Area は境界線だけを描き、終点から始点へ自動で閉じる（面の塗りは未対応）。

## 制限

- iPhone は iOS 16.4 以降の Safari。LINE や X のアプリ内ブラウザではカメラが動かないことがある。
- 白地に細い線だけの図面は認識できない。`tools/` の「追跡用」の数で事前に確かめる。
- 揺れ止めのため、端末を速く動かすとモデルが図面より少し遅れて動く。
- 図面が画面から外れるとモデルは画面上で固定される（図面を画面いっぱいに映し直すと追跡に復帰する）。
- 同時に追う図面は1枚。読み込んだモデルは2件まで保持し、古いものから捨てる。
