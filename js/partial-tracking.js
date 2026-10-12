// 近づいたときは細かい参照画像を使い、画面内の特徴点だけを照合する。
// 座標は元の図面全体のまま。部分画像を別の図面として登録しない。
export const PARTIAL_POINT_LIMIT = 64;
const FRAME_TAG = 'close-up-v1';

function project(K, pose, x, y) {
  const p = pose.map(row => row[0] * x + row[1] * y + row[3]);
  if (!(p[2] > 1e-6)) return null;
  const v = K.map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
  return { x: v[0] / v[2], y: v[1] / v[2] };
}

export function isCloseView(dimensions, K, pose, width, height) {
  const [w, h] = dimensions;
  const corners = [[0,0],[w,0],[w,h],[0,h]].map(([x,y]) => project(K, pose, x, y));
  if (corners.some(p => !p)) return true;
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
  return Math.max(...xs) - Math.min(...xs) > width * 1.2 || Math.max(...ys) - Math.min(...ys) > height * 1.2;
}

export function visibleFeatures(frame, K, pose, width, height) {
  const cells = Array.from({ length: 64 }, () => []);
  let visible = 0;
  const inside = p => p && p.x >= 2 && p.y >= 2 && p.x < width - 2 && p.y < height - 2;
  const radius = 16 / frame.scale; // 小窓半径6 + 探索範囲10。画面外の模様を照合しない。
  for (const point of frame.points) {
    const x = point.x / frame.scale, y = point.y / frame.scale;
    const center = project(K, pose, x, y);
    if (!inside(center)) continue;
    if (![[x-radius,y-radius],[x+radius,y-radius],[x+radius,y+radius],[x-radius,y+radius]]
      .every(([px,py]) => inside(project(K, pose, px, py)))) continue;
    visible++;
    const cell = Math.min(7, Math.floor(center.y / height * 8)) * 8 + Math.min(7, Math.floor(center.x / width * 8));
    cells[cell].push(point);
  }
  // 強い模様の一か所に集中させず、画面上に分散した点を上限数まで選ぶ。
  const points = [];
  for (let rank = 0; points.length < PARTIAL_POINT_LIMIT; rank++) {
    let added = false;
    for (const cell of cells) {
      if (cell[rank]) { points.push(cell[rank]); added = true; }
      if (points.length === PARTIAL_POINT_LIMIT) break;
    }
    if (!added) break;
  }
  return { points, visible };
}

// 点数だけでなく、位置・傾きの計算に必要な二次元の広がりを確認する。
export function hasPointSpread(points, width, height) {
  if (points.length < 6) return false;
  const mean = points.reduce((p,q) => ({x:p.x+q.x/points.length,y:p.y+q.y/points.length}), {x:0,y:0});
  let xx=0, xy=0, yy=0;
  for (const p of points) { const x=(p.x-mean.x)/width, y=(p.y-mean.y)/height; xx+=x*x; xy+=x*y; yy+=y*y; }
  const trace=xx+yy, determinant=xx*yy-xy*xy;
  return trace / points.length > 0.0004 && determinant > trace * trace * 0.003;
}

export class PartialTracker {
  constructor(controller, tf, minPoints = 6) {
    this.controller = controller;
    this.tf = tf;
    this.minPoints = Math.max(6, minPoints);
    this.trackers = new Map();
    this.frames = (controller.tracker.trackingDataList || []).map(list => list.find(frame => frame.purpose === FRAME_TAG));
  }

  trackFine(input, pose, index) {
    const c = this.controller, frame = this.frames[index];
    if (!frame || !this.tf) return null;
    const selected = visibleFeatures(frame, c.projectionTransform, pose, c.inputWidth, c.inputHeight);
    const info = { mode:'部分', candidates:selected.points.length, visible:selected.visible, registered:frame.points.length };
    if (selected.points.length < this.minPoints) return { worldCoords:[], screenCoords:[], ...info };
    let tracker = this.trackers.get(index);
    if (!tracker) {
      // 照合数は固定64。参照画像の全特徴点を毎コマ照合しない。
      const seed = { ...frame, points:Array.from({length:PARTIAL_POINT_LIMIT}, (_,i) => frame.points[i % frame.points.length]) };
      tracker = new c.tracker.constructor([c.markerDimensions[index]], [[seed, seed]], c.projectionTransform, c.inputWidth, c.inputHeight);
      this.trackers.set(index, tracker);
    }
    const coordinates = new Float32Array(PARTIAL_POINT_LIMIT * 2).fill(-1);
    selected.points.forEach((p,i) => { coordinates[i*2]=p.x/frame.scale; coordinates[i*2+1]=p.y/frame.scale; });
    const features = this.tf.tensor(coordinates, [PARTIAL_POINT_LIMIT, 2], 'float32');
    tracker.featurePointsListT[0].dispose();
    tracker.featurePointsListT[0] = features;
    tracker.trackingKeyframeList[0] = { ...frame, points:selected.points };
    const result = tracker.track(input, pose, 0);
    if (!hasPointSpread(result.screenCoords, c.inputWidth, c.inputHeight)) {
      return { worldCoords:[], screenCoords:[], ...info };
    }
    return { ...result, ...info };
  }

  track(input, pose, index) {
    const c = this.controller;
    let fine = null;
    if (this.frames[index] && isCloseView(c.markerDimensions[index], c.projectionTransform, pose, c.inputWidth, c.inputHeight)) {
      fine = this.trackFine(input, pose, index);
      if (fine && fine.worldCoords.length >= this.minPoints) return fine;
    }
    const standard = { ...c.tracker.track(input, pose, index), mode:'全体', candidates:0, visible:0, registered:0 };
    if (standard.worldCoords.length >= this.minPoints) return standard;
    if (!fine) fine = this.trackFine(input, pose, index);
    return fine && fine.worldCoords.length >= standard.worldCoords.length ? fine : standard;
  }

  dispose() {
    for (const tracker of this.trackers.values()) {
      this.tf.dispose([tracker.featurePointsListT, tracker.imagePixelsListT, tracker.imagePropertiesListT]);
    }
    this.trackers.clear();
  }
}
