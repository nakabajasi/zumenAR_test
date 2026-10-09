// AR表示。図面（認識対象）ごとに置き場所を用意し、認識できた図面のモデルだけを読み込む
import * as THREE from 'three';
import { MindARThree } from '../lib/mindar/mindar-image-three.prod.js';
import {
  url, loadCatalog, itemFromQuery, fetchJson, isInAppBrowser, loadItemObject, addLights,
  buildAnnotations, pickAnnotation, syncLineResolution,
} from './common.js';
import { createPanel } from './panel.js';
import { TRACKING_DEFAULTS, trackingStats, installTracking } from './tracking.js';
import { PoseStabilizer } from './stabilizer.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const hint = $('hint');
const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };
// 図面は近いほど見つけやすい（擬似映像での成功率：画面いっぱい約9割、画面幅の半分では約3割）
const SCAN_HINT = '図面が画面いっぱいになるように近づけてください';
const HOLD_HINT = '図面を見失いました。図面を画面いっぱいに映すと再開します';
const KEEP_LOADED = 2;   // 同時に持つモデルの数。iPhoneのメモリ不足を避ける
const DEFAULT_FIT = 0.35;

let mindar = null;
let running = false;
let slots = [];
let current = null;      // いま情報パネルに出している資料
let panel = null;
let tracking = { ...TRACKING_DEFAULTS };
const debug = new URLSearchParams(location.search).has('debug');

/* ---------- 置き方 ---------- */

// 図面の幅を1としたときの、モデル最大寸法の大きさ
function displayScale(item, model) {
  const size = (item.display && item.display.size) || { type: 'fit', value: DEFAULT_FIT };
  if (size.type === 'scale') {
    // 図面と同じ縮尺で出す：実寸(mm)×縮尺 ÷ 印刷した図面の幅(mm)
    const printWidth = item.target.printWidthMm;
    const metersPerUnit = item.model.metersPerUnit;
    if (printWidth && metersPerUnit) return (model.maxDim * metersPerUnit * 1000 * size.value) / printWidth;
    console.warn(`${item.id}: 縮尺で出すには target.printWidthMm と model.metersPerUnit が必要です`);
    return DEFAULT_FIT;
  }
  return size.value;
}

function makeSlot(item) {
  const anchor = mindar.addAnchor(item.targetIndex); // MindAR が出す生の姿勢（そのままでは細かく揺れる）
  const aspect = item.target.heightPx / item.target.widthPx;
  const [u, v] = (item.display && item.display.anchor) || [0.5, 0.5];
  const root = new THREE.Group();   // なめらかにした姿勢。モデルはこちらに入れる
  root.visible = false;
  const place = new THREE.Group();  // 図面上の置き場所（左上が0,0・右下が1,1）
  place.position.set(u - 0.5, (0.5 - v) * aspect, 0);
  const user = new THREE.Group();   // 指での回転・拡大
  place.add(user);
  root.add(place);
  mindar.scene.add(root);
  const slot = {
    item, anchor, root, user, stabilizer: new PoseStabilizer(tracking),
    pose: null, model: null, annotations: null, meta: null, loading: null, usedAt: 0,
  };
  anchor.onTargetFound = () => onFound(slot);
  anchor.onTargetLost = () => onLost(slot);
  return slot;
}

function ensureLoaded(slot) {
  if (slot.model) return Promise.resolve(slot);
  if (slot.loading) return slot.loading;
  const { item } = slot;
  slot.loading = Promise.all([
    loadItemObject(item, (p) => { if (current === slot || !current) showHint(`モデルを読み込み中… ${Math.round(p * 100)}%`); }),
    item.meta ? fetchJson(item.meta).catch(() => null) : null,
    item.annotations ? fetchJson(item.annotations).catch(() => null) : null,
  ]).then(([model, meta, annoData]) => {
    const mode = (item.display && item.display.mode) || 'stand';
    const k = displayScale(item, model);
    const pose = new THREE.Group();
    pose.scale.setScalar(k);
    if (mode === 'lay') {
      // 図に重ねて寝かせる：モデルの上を図面の上に向け、中心を置き場所に合わせる
      pose.position.set(0, (-model.unitSize.y / 2) * k, (model.unitSize.z / 2) * k);
    } else {
      // 紙の上に立たせる：モデルの上を紙から手前へ向ける
      pose.rotation.x = Math.PI / 2;
    }
    pose.add(model.unit);
    slot.user.add(pose);
    const annotations = buildAnnotations(annoData, model.maxDim);
    model.raw.add(annotations.group);
    Object.assign(slot, { model, meta, annotations, pose, mode, loading: null });
    releaseOld(slot);
    return slot;
  }).catch((err) => {
    slot.loading = null;
    console.error(err);
    showHint(`モデルを読み込めません：${err.message}`);
    throw err;
  });
  return slot.loading;
}

function releaseOld(keep) {
  const loaded = slots.filter((s) => s.model && s !== keep && s !== current).sort((a, b) => a.usedAt - b.usedAt);
  while (loaded.length > KEEP_LOADED - 1) {
    const s = loaded.shift();
    s.user.remove(s.pose);
    s.annotations.dispose();
    s.model.dispose();
    s.model = s.annotations = s.pose = null;
  }
}

/* ---------- 認識の開始・終了 ---------- */

function bindPanel(slot) {
  panel.setItem(slot.item, slot.meta);
  panel.setLayers(slot.annotations.layers);
  $('btn-mode').setAttribute('aria-pressed', String(slot.model.mode === 'shape'));
  $('panel').hidden = false;
}

function onFound(slot) {
  $('recover').hidden = true;
  slot.usedAt = performance.now();
  const changed = current !== slot;
  current = slot;
  showHint('');
  ensureLoaded(slot).then(() => {
    if (current !== slot) return;
    showHint(slot.anchor.visible ? '' : (slot.stabilizer.ready ? HOLD_HINT : SCAN_HINT));
    if (changed || $('panel').hidden) bindPanel(slot);
  }).catch(() => {});
}

function onLost(slot) {
  // パネルは残す（図面から目を離しても情報を読み続けられるように）
  if (current !== slot) return;
  showHint(tracking.hold && slot.model ? HOLD_HINT : SCAN_HINT);
  $('recover').hidden = false; // 戻しても再開しないときに、読み込み直さずやり直せるようにする
}

/* ---------- 指の操作 ---------- */

function setupGestures() {
  const pointers = new Map();
  let pinch = null;
  let tap = null;

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
    pinch = pointers.size === 2 && current && current.model ? { dist: spread(), scale: current.user.scale.x } : null;
  });

  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    p.x = e.clientX; p.y = e.clientY;
    if (!current || !current.model) return;
    if (pointers.size === 1) {
      // 横になぞると、モデルの軸まわりに回る
      const axis = current.mode === 'lay' ? 'y' : 'z';
      current.user.rotation[axis] += dx * 0.01;
    } else if (pinch) {
      const s = THREE.MathUtils.clamp(pinch.scale * (spread() / pinch.dist), 0.3, 4);
      current.user.scale.setScalar(s);
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinch = null;
    if (e.type !== 'pointerup' || !tap) return;
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    const quick = e.timeStamp - tap.t < 400; // 処理が混んでいても正しく測れるよう、指が触れた時刻そのもので比べる
    tap = null;
    if (moved > 8 || !quick || !current || !current.model || !current.root.visible) return;
    const entry = pickAnnotation(e.clientX, e.clientY, mindar.renderer.domElement, mindar.camera, current.annotations, current.model);
    current.annotations.select(entry);
    panel.showSelection(entry);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

/* ---------- 起動 ---------- */

let lastRender = 0;
function render(now) {
  const dt = Math.min((now - lastRender) / 1000, 0.1);
  lastRender = now;
  for (const slot of slots) {
    const live = slot.anchor.visible ? slot.anchor.group.matrix : null;
    slot.stabilizer.update(live, dt, now);
    slot.root.visible = slot === current && !!slot.model && slot.stabilizer.ready;
    if (slot.root.visible) slot.stabilizer.applyTo(slot.root);
  }
  syncLineResolution(mindar.renderer);
  mindar.renderer.render(mindar.scene, mindar.camera);
  watchdog(now);
  if (debug) updateDebug(now);
}

// 追跡の処理が止まった・例外が続くときは、追跡だけを作り直す（カメラはそのまま）
let healedAt = -1e9;
let heals = 0;
function watchdog(now) {
  if (!running) return;
  const t = trackingStats;
  if (t.errorStreak < 5 && now - t.lastFrameAt < 3000) return;
  if (now - healedAt < 8000) {
    // 作り直した直後にまた止まった：自動では直せない
    if (now - healedAt > 3000) { showHint('追跡が止まりました。「探し直す」を押してください'); $('recover').hidden = false; }
    return;
  }
  healedAt = now; heals += 1;
  const controller = mindar.controller;
  controller.stopProcessVideo();
  // MindAR 側の「見えている」という記録を消してから始め直す
  slots.forEach((s) => { if (s.anchor.visible) controller.onUpdate({ type: 'updateMatrix', targetIndex: s.item.targetIndex, worldMatrix: null }); });
  t.errorStreak = 0; t.lastFrameAt = performance.now();
  controller.processVideo(mindar.video);
}

// ?debug=1 を付けると、追跡の状態を画面に出す（実機での調整用）
let debugBox = null;
let debugAt = 0;
let renderCount = 0;
let renderFps = 0;
function updateDebug(now) {
  renderCount += 1;
  if (now - debugAt < 500) return;
  renderFps = (renderCount * 1000) / (now - debugAt);
  renderCount = 0; debugAt = now;
  if (!debugBox) {
    debugBox = document.createElement('pre');
    debugBox.className = 'debug';
    document.body.append(debugBox);
  }
  const t = trackingStats;
  const v = mindar.video;
  debugBox.textContent = [
    `状態 ${t.state}${current && current.stabilizer.held ? '（固定表示）' : ''}`,
    `認識 ${t.fps.toFixed(1)}回/秒  描画 ${renderFps.toFixed(0)}回/秒`,
    `手がかり ${t.points}点（表示中の最少 ${Number.isFinite(t.minPointsSeen) ? t.minPointsSeen : '-'}）`,
    `発見 ${t.detections}（一部 ${t.hits.crop}/${t.tries.crop}  全体 ${t.hits.full}/${t.tries.full}）  却下 ${t.rejected}`,
    `探し直し ${t.fallbacks}  見失い ${t.lost}  作り直し ${heals}`,
    `エラー ${t.errors}${t.lastError ? ` ${t.lastError.slice(0, 40)}` : ''}${performance.now() - t.lastFrameAt > 1500 ? '  ※処理停止中' : ''}`,
    `映像 ${v ? `${v.videoWidth}×${v.videoHeight}` : '-'}  画素比 ${mindar.renderer.getPixelRatio()}`,
  ].join('\n');
}

// 端末を回すとカメラ映像の縦横が入れ替わるので、認識を作り直す
let restartTimer = null;
function scheduleRestart() {
  if (!running) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, 350);
}
// カメラと追跡を最初から作り直す（ページの再読み込みに近いが、モデルや情報パネルは残る）
async function restart() {
  if (!running) return;
  running = false;
  $('recover').hidden = true;
  showHint('探し直しています…');
  mindar.renderer.setAnimationLoop(null);
  try {
    mindar.stop();
    slots.forEach((s) => { s.stabilizer.reset(); s.anchor.visible = false; }); // 前の姿勢は捨てる
    await mindar.start();
    trackingStats.errorStreak = 0; trackingStats.lastFrameAt = performance.now();
    mindar.renderer.setAnimationLoop(render);
    running = true;
    showHint(SCAN_HINT);
  } catch (err) {
    showHint('カメラを再開できません。ページを読み込み直してください');
  }
}

async function start(catalog, preferred) {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザではカメラを使えません。SafariかChromeで開いてください。');
  }
  stage.innerHTML = ''; // やり直しのときに前回の映像・描画面を残さない

  // 追跡の設定：既定値 ← 台帳の tracking ← URL（例 ar.html?debug=1&stillCutoff=0.3）
  Object.assign(tracking, catalog.tracking || {});
  const query = new URLSearchParams(location.search);
  for (const key of Object.keys(TRACKING_DEFAULTS)) {
    if (query.has(key) && Number.isFinite(Number(query.get(key)))) tracking[key] = Number(query.get(key));
  }
  installTracking(tracking);

  mindar = new MindARThree({
    container: stage,
    imageTargetSrc: url('targets/all.mind'),
    maxTrack: 1,
    uiLoading: 'no', uiScanning: 'no', uiError: 'no',
    warmupTolerance: tracking.warmupTolerance,
  });
  mindar.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mindar.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showHint('表示が止まりました。ページを読み込み直してください');
  });
  addLights(mindar.scene);
  slots = catalog.items.map(makeSlot);

  try {
    await mindar.start();
  } catch (err) {
    throw new Error('カメラを起動できませんでした。ブラウザの設定でこのページのカメラ使用を許可してください。');
  }
  running = true;
  mindar.renderer.setAnimationLoop(render);
  setupGestures();

  // QRで資料を指定して開いた場合は、認識を待たずにそのモデルを先に読み込んでおく
  const first = preferred && slots.find((s) => s.item.id === preferred.id);
  if (first) ensureLoaded(first).then(() => { if (!current) showHint(SCAN_HINT); }).catch(() => {});

  window.addEventListener('orientationchange', scheduleRestart);
  if (screen.orientation) screen.orientation.addEventListener('change', scheduleRestart);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !running) return;
    trackingStats.lastFrameAt = performance.now(); // 画面を離れていた時間を「処理が止まった」と数えない
    if (mindar.video && mindar.video.paused) mindar.video.play().catch(() => {});
  });
}

async function main() {
  const catalog = await loadCatalog();
  const preferred = itemFromQuery(catalog);
  if (preferred) $('link-viewer').href = `viewer.html?id=${encodeURIComponent(preferred.id)}`;
  if (isInAppBrowser()) $('inapp').hidden = false;

  panel = createPanel($('panel'), {
    onLayerToggle: (layer, on) => { layer.object.visible = on; },
    onClearSelection: () => { if (current && current.annotations) current.annotations.select(null); panel.showSelection(null); },
  });

  $('btn-mode').addEventListener('click', () => {
    if (!current || !current.model) return;
    const shape = current.model.mode !== 'shape';
    current.model.setMode(shape ? 'shape' : 'photo');
    $('btn-mode').setAttribute('aria-pressed', String(shape));
  });
  $('btn-rescan').addEventListener('click', () => (running ? restart() : location.reload()));
  $('btn-reset').addEventListener('click', () => {
    if (!current) return;
    current.user.rotation.set(0, 0, 0);
    current.user.scale.setScalar(1);
  });

  const startBtn = $('btn-start');
  const errorBox = $('gate-error');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = '準備中…';
    errorBox.hidden = true;
    try {
      await start(catalog, preferred);
      $('gate').hidden = true;
      $('topbar').hidden = false;
      if (!current) showHint(SCAN_HINT);
    } catch (err) {
      console.error(err);
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      startBtn.disabled = false;
      startBtn.textContent = 'もう一度試す';
    }
  });

  window.__ar = { get mindar() { return mindar; }, get slots() { return slots; }, get current() { return current; }, restart, tracking, stats: trackingStats }; // 確認用
}

main().catch((err) => {
  console.error(err);
  $('gate-error').textContent = `準備できません：${err.message}`;
  $('gate-error').hidden = false;
  $('btn-start').disabled = true;
});
