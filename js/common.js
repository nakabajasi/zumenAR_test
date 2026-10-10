// 共通処理：台帳の読み込み、モデルの読み込みと向き・大きさの正規化、アノテーションの生成
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { prepareModelFrame } from './placement.js?rev=blender-origin-1';

// サイトの最上位フォルダ。GitHub Pages の /リポジトリ名/ 配下でも動くよう相対で解決する
const ROOT = new URL('..', import.meta.url);
export const url = (path) => new URL(path, ROOT).href;

export async function fetchJson(path) {
  const res = await fetch(url(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} を読み込めません (${res.status})`);
  return res.json();
}

let catalogPromise = null;
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchJson('data/items.json').then((c) => {
      c.items.sort((a, b) => a.targetIndex - b.targetIndex);
      return c;
    });
  }
  return catalogPromise;
}

export function itemFromQuery(catalog) {
  const id = new URLSearchParams(location.search).get('id');
  return catalog.items.find((it) => it.id === id) || null;
}

// LINE や X などのアプリ内ブラウザではカメラが使えないことがある
export function isInAppBrowser() {
  return /Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(navigator.userAgent);
}

/* ---------- モデル ---------- */

const draco = new DRACOLoader().setDecoderPath(url('lib/draco/'));
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

const SHAPE_COLOR = 0xcbc3b4;

/**
 * モデルを読み込み、次の入れ子にして返す。
 *   unit     … 通常ビューでは最大寸法1。ARでは配置を保持する。
 *   └ oriented … 通常ビューだけ向き・中心・大きさを補正。ARでは恒等変換。
 *      └ raw   … GLBの座標そのまま。アノテーションはここに入れる
 */
export async function loadItemObject(item, onProgress, options = {}) {
  const gltf = await gltfLoader.loadAsync(url(item.model.src), (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });

  const frame = prepareModelFrame(gltf.scene, item, options);

  // 表示の切り替え：photo＝写真の色をそのまま（光の計算なし）／shape＝色を外して形だけ
  const meshes = [];
  let triangles = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    const photo = new THREE.MeshBasicMaterial({ map: src.map || null, color: src.map ? 0xffffff : src.color });
    // 表面に沿ったアノテーションの線がちらつかないよう、面をわずかに奥へずらす
    photo.polygonOffset = true; photo.polygonOffsetFactor = 1; photo.polygonOffsetUnits = 1;
    o.material = photo;
    src.dispose();
    meshes.push({ mesh: o, photo, shape: null });
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });

  let mode = 'photo';
  function setMode(next) {
    mode = next;
    for (const m of meshes) {
      if (next === 'shape') {
        if (!m.shape) {
          if (!m.mesh.geometry.attributes.normal) m.mesh.geometry.computeVertexNormals();
          m.shape = new THREE.MeshStandardMaterial({ color: SHAPE_COLOR, roughness: 0.85, metalness: 0 });
          m.shape.polygonOffset = true; m.shape.polygonOffsetFactor = 1; m.shape.polygonOffsetUnits = 1;
        }
        m.mesh.material = m.shape;
      } else {
        m.mesh.material = m.photo;
      }
    }
  }

  function dispose() {
    for (const m of meshes) {
      m.mesh.geometry.dispose();
      if (m.photo.map) m.photo.map.dispose();
      m.photo.dispose();
      if (m.shape) m.shape.dispose();
    }
  }

  return {
    ...frame, triangles,
    get mode() { return mode; },
    setMode, dispose,
  };
}

// 形だけの表示に使う光。写真表示には影響しない
// 見る人の側の左上から当てる（実測図の陰影の慣習に合わせ、かつ手前の面が暗くならない向き）
export function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.0);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-0.8, 0.7, 1.6);
  scene.add(hemi, key);
  return { hemi, key };
}

/* ---------- アノテーション ---------- */

const lineMaterials = new Set();
const _res = new THREE.Vector2();
// 太線は画面の画素数を知らないと太さが決まらないので、描画のたびに渡す
export function syncLineResolution(renderer) {
  renderer.getDrawingBufferSize(_res);
  for (const m of lineMaterials) m.resolution.copy(_res);
}

const LINE_WIDTH = 3;        // 画面上の太さ（px）
const LINE_WIDTH_ACTIVE = 6;
const TYPE_LABEL = { Point: '点', Line: '線', Area: '面' };
export const typeLabel = (t) => TYPE_LABEL[t] || t;

/**
 * annotations.json からアノテーションを作る。座標は GLB の座標（raw に入れる前提）。
 * 戻り値の layers[n].object の visible でレイヤーごとに表示を切り替える。
 */
export function buildAnnotations(data, maxDim) {
  const group = new THREE.Group();
  const layers = [];
  const pickables = [];
  if (!data || !Array.isArray(data.layers)) return { group, layers, pickables, select() {}, dispose() {} };

  const r = maxDim * 0.011;
  const sphereGeo = new THREE.SphereGeometry(r, 20, 14);
  const hitGeo = new THREE.SphereGeometry(r * 2.6, 8, 6); // 指で押しやすいよう当たり判定だけ大きく
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });

  for (const def of data.layers) {
    const object = new THREE.Group();
    const color = new THREE.Color(def.color || '#d9482b');
    const layer = {
      uid: def.uid, name: def.name, type: def.Annotation_Type,
      color: `#${color.getHexString()}`, metadata: def.metadata || {}, object, entries: [],
    };

    (def.items || []).forEach((it, index) => {
      const entry = { layer, index, label: it.label || '', note: it.note || '', visual: null };
      if (layer.type === 'Point') {
        const dot = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color }));
        dot.position.fromArray(it.position);
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.userData.entry = entry;
        dot.add(hit);
        object.add(dot);
        pickables.push(hit);
        entry.visual = dot;
      } else {
        const pts = it.points.slice();
        if (layer.type === 'Area') pts.push(pts[0]); // 面の境界は必ず閉じる
        const geo = new LineGeometry().setPositions(pts.flat());
        const mat = new LineMaterial({ color, linewidth: LINE_WIDTH, worldUnits: false });
        lineMaterials.add(mat);
        const line = new Line2(geo, mat);
        line.computeLineDistances();
        line.userData.entry = entry;
        object.add(line);
        pickables.push(line);
        entry.visual = line;
      }
      layer.entries.push(entry);
    });

    group.add(object);
    layers.push(layer);
  }

  let selected = null;
  function mark(entry, on) {
    if (!entry) return;
    if (entry.layer.type === 'Point') entry.visual.scale.setScalar(on ? 1.7 : 1);
    else entry.visual.material.linewidth = on ? LINE_WIDTH_ACTIVE : LINE_WIDTH;
  }
  function select(entry) {
    mark(selected, false);
    selected = entry || null;
    mark(selected, true);
  }

  function dispose() {
    group.traverse((o) => {
      if (o.isLine2) { lineMaterials.delete(o.material); o.material.dispose(); o.geometry.dispose(); }
      else if (o.isMesh && o.material !== hitMat) o.material.dispose();
    });
    sphereGeo.dispose(); hitGeo.dispose(); hitMat.dispose();
  }

  return { group, layers, pickables, select, dispose };
}

const raycaster = new THREE.Raycaster();
raycaster.params.Line2 = { threshold: 14 }; // 線は指で押しやすいよう太めに判定（px）
const _ndc = new THREE.Vector2();

const _scale = new THREE.Vector3();

// 画面上の位置からアノテーションを1つ拾う。非表示レイヤーのものと、モデルの裏側に隠れたものは拾わない
export function pickAnnotation(clientX, clientY, dom, camera, annotations, model) {
  const rect = dom.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const live = annotations.pickables.filter((p) => p.userData.entry.layer.object.visible);
  const hit = raycaster.intersectObjects(live, false)[0];
  if (!hit) return null;
  const surface = raycaster.intersectObject(model.raw.children[0], true)[0];
  if (surface) {
    const extent = Math.max(model.unitSize.x, model.unitSize.y, model.unitSize.z);
    const slack = model.unit.getWorldScale(_scale).x * extent * 0.06; // 配置保持時もモデル最大寸法の6%
    if (surface.distance < hit.distance - slack) return null;
  }
  return hit.object.userData.entry;
}
