この資料（kidan）の注記の図形を置くフォルダ。

ここに置くもの
  notes.glb … 図面のベクトルデータを Blender で3Dモデルに重ね、図形だけを書き出したもの。
              オブジェクト名を遺構番号にする。書き出しでは「ルーズエッジ」「ルーズポイント」を入れ、
              「+Y上」は本体と同じにし、圧縮はかけない。

置いたら、data/items.json の kidan の資料に次を足す（遺構一覧表は data/tables/ に置く）。

  "annotations": {
    "glb": "data/kidan/annotations/notes.glb",
    "table": "data/tables/遺構一覧.csv",
    "key": "遺構番号",
    "layer": "種別",
    "note": "備考"
  }

key・layer・note は、遺構一覧表の見出しに合わせて書き換える。詳しくは README.md の
「図面のベクトルデータと遺構一覧表で付ける」。
