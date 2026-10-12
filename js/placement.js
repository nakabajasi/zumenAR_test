// 図面左下＝Blender原点。モデルの外寸・中心から配置を決めない。
import * as THREE from 'three';

// 入力寸法の丸めを許容する範囲。大きく違う場合は縦横別倍率で形を変えず、設定エラーにする。
const ASPECT_TOLERANCE = 0.01;

export function modelCoordinateSystem(item) {
  const value = item.model.coordinateSystem ?? 'gltf-y-up';
  if (value !== 'gltf-y-up' && value !== 'blender-z-up') {
    throw new Error(`${item.id}: model.coordinateSystem は gltf-y-up または blender-z-up を指定してください`);
  }
  return value;
}

function positive(value, name, item) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${item.id}: ${name} は0より大きい数値で指定してください`);
  }
  return value;
}

// dimensionsは認識に使用するall.mindから取得する。台帳の旧画素数は参照しない。
export function createDrawingPlacement(item, dimensions) {
  const target = item.target || {};
  const widthPx = positive(dimensions?.[0], 'all.mind内の画像幅（px）', item);
  const heightPx = positive(dimensions?.[1], 'all.mind内の画像高さ（px）', item);
  // 単位はm。省略時に仮の寸法を当てはめず、縦横とも明示入力を必須にする。
  const width = positive(target.realWidthM, 'target.realWidthM（画像全体の実寸幅・m）', item);
  const height = positive(target.realHeightM, 'target.realHeightM（画像全体の実寸高さ・m）', item);
  const aspect = heightPx / widthPx;
  const aspectError = Math.abs((height / width) / aspect - 1);
  if (!Number.isFinite(aspectError) || aspectError > ASPECT_TOLERANCE) {
    throw new Error(`${item.id}: 認識データ内の画像（${widthPx}×${heightPx}px）と実寸（${width}×${height}m）の縦横比が1%を超えて異なります。余白を含む画像全体の実寸を確認してください。画像を差し替えた場合は、管理用ページでall.mindを作り直して置き換えてください`);
  }
  const coordinateSystem = modelCoordinateSystem(item);
  const group = new THREE.Group();
  // MindARのアンカーは画像中心・幅1。固定の変換で画像左下へ移す。
  group.position.set(-0.5, -aspect / 2, 0);
  // 縦横比の一致を確認した上で、XYZすべてを横幅に基づく共通倍率で変換する。
  // 認識に使われた図柄の範囲・モデルの外寸・印刷物のmm幅からは計算しない。
  group.scale.setScalar(1 / width);
  // 標準GLBの (x,y,z) → Blenderの (x,-z,y)。モデルの向きの再調整ではない。
  if (coordinateSystem === 'gltf-y-up') group.rotation.x = Math.PI / 2;
  return { group, width, height, widthPx, heightPx, aspectError, coordinateSystem };
}

export function createDrawingPlacements(items, dimensions) {
  const used = new Set();
  return items.map((item) => {
    const index = item.targetIndex;
    if (!Number.isInteger(index) || index < 0 || !dimensions[index] || used.has(index)) {
      throw new Error(`${item.id}: targetIndexとall.mindの対応を確認してください。管理用ページで認識データを作り直して置き換えてください`);
    }
    used.add(index);
    return createDrawingPlacement(item, dimensions[index]);
  });
}

/**
 * AR: preservePlacement=true でGLBルート以下の位置・回転・倍率をそのまま保持。
 * 通常ビュー: 上を+Yにそろえ、底面中心・最大寸法1で観察できるようにする。
 * rawはGLBシーン座標。メッシュローカル座標とは異なる。
 */
export function prepareModelFrame(scene, item, { preservePlacement = false } = {}) {
  const raw = new THREE.Group();
  raw.add(scene);
  const oriented = new THREE.Group();
  oriented.add(raw);
  if (!preservePlacement) {
    const fallback = modelCoordinateSystem(item) === 'blender-z-up' ? [-90, 0, 0] : [0, 0, 0];
    oriented.rotation.set(...(item.model.rotationDeg ?? fallback).map(THREE.MathUtils.degToRad));
  }
  oriented.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(oriented);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = preservePlacement ? 1 : 1 / maxDim;
  if (!preservePlacement) {
    const center = bounds.getCenter(new THREE.Vector3());
    oriented.scale.setScalar(scale);
    oriented.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  }
  const unit = new THREE.Group();
  unit.add(oriented);
  return { unit, raw, size, maxDim, bounds, unitSize: size.clone().multiplyScalar(scale) };
}

// AR用に保持したGLB範囲をBlender XYZへ変換。診断表示だけに使い、配置は動かさない。
export function blenderBounds(model, coordinateSystem) {
  const bounds = model.bounds.clone();
  if (coordinateSystem === 'gltf-y-up') bounds.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  return bounds;
}
