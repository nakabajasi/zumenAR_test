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

`site.title` と `site.lead` は一覧の見出し。`tracking` を足すと MindAR の設定
（`filterMinCF`、`filterBeta`、`warmupTolerance`、`missTolerance`）を上書きできる。

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
- 同時に追う図面は1枚。読み込んだモデルは2件まで保持し、古いものから捨てる。
