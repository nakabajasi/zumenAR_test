// 通常の3D表示。カメラが使えない端末や、図面を認識できなかったときの逃げ先
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadCatalog, itemFromQuery, fetchJson, loadItemObject, addLights,
  buildAnnotations, pickAnnotation, syncLineResolution,
} from './common.js?rev=blender-origin-1';
import { createPanel } from './panel.js?rev=blender-origin-1';

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');
const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };

async function main() {
  const catalog = await loadCatalog();
  const item = itemFromQuery(catalog) || catalog.items[0];
  if (!item) throw new Error('台帳に資料がありません');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
  const lights = addLights(scene);
  camera.add(lights.key); // 光はカメラについて回る（どの向きでも左上から当たる）
  scene.add(camera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.4;
  controls.maxDistance = 8;

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const [model, meta, annoData] = await Promise.all([
    loadItemObject(item, (p) => showHint(`読み込み中… ${Math.round(p * 100)}%`)),
    item.meta ? fetchJson(item.meta).catch(() => null) : null,
    item.annotations ? fetchJson(item.annotations).catch(() => null) : null,
  ]);
  showHint('');
  scene.add(model.unit);
  const annotations = buildAnnotations(annoData, model.maxDim);
  model.raw.add(annotations.group);

  const target = new THREE.Vector3(0, model.unitSize.y / 2, 0);
  function resetView() {
    // 縦長の画面では横幅が先に切れるので、その分だけ引く
    const fit = Math.max(1, 0.95 / camera.aspect);
    const dist = (1.15 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.62 * fit;
    camera.position.set(dist * 0.42, target.y + dist * 0.28, dist * 0.86);
    controls.target.copy(target);
    controls.update();
  }
  resetView();

  const panelEl = document.getElementById('panel');
  const panel = createPanel(panelEl, {
    onLayerToggle: (layer, on) => { layer.object.visible = on; },
    onClearSelection: () => { annotations.select(null); panel.showSelection(null); },
  });
  panel.setItem(item, meta);
  panel.setLayers(annotations.layers);
  panelEl.hidden = false;

  const modeBtn = document.getElementById('btn-mode');
  modeBtn.addEventListener('click', () => {
    const shape = model.mode !== 'shape';
    model.setMode(shape ? 'shape' : 'photo');
    modeBtn.setAttribute('aria-pressed', String(shape));
  });
  document.getElementById('btn-reset').addEventListener('click', resetView);

  // 軽くたたいた（動かしていない）ときだけアノテーションを選ぶ
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = e.timeStamp - down.t < 400;
    down = null;
    if (moved > 8 || !quick) return;
    const entry = pickAnnotation(e.clientX, e.clientY, renderer.domElement, camera, annotations, model);
    annotations.select(entry);
    panel.showSelection(entry);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    syncLineResolution(renderer);
    renderer.render(scene, camera);
  });
  window.__viewer = { model, annotations, camera, controls }; // 確認用
}

main().catch((err) => { console.error(err); showHint(`表示できません：${err.message}`); });
