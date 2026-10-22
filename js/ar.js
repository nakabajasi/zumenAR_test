// AR表示。図面（認識対象）ごとに置き場所を用意し、認識できた図面に載っている資料のモデルを読み込む
import * as THREE from 'three';
// 読み込む順番に意味がある：tracking.js が先。MindAR の2つのファイルはどちらも window.MINDAR.IMAGE に
// 部品を登録するが、tracking.js が使う側は丸ごと置き換え、下の three 用は追記する。逆順だと追記分が消える
import { TRACKING_DEFAULTS, trackingStats, installTracking } from './tracking.js';
import { MindARThree } from '../lib/mindar/mindar-image-three.prod.js';
import {
  url, loadCatalog, itemFromQuery, targetFromQuery, fetchJson, isInAppBrowser, loadItemObject, addLights,
  buildAnnotations, pickAnnotation, pickModel, syncLineResolution, placePosition, buildPose, displayMode, findEntry,
} from './common.js';
import { createPanel } from './panel.js';
import { loadAnnotationData } from './annotations.js';
import { PoseStabilizer } from './stabilizer.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const hint = $('hint');
const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };
// 図面は近いほど見つけやすい（擬似映像での成功率：画面いっぱい約9割、画面幅の半分では約3割）
const SCAN_HINT = '図面が画面いっぱいになるように近づけてください';
const HOLD_HINT = '図面を見失いました。図面を画面いっぱいに映すと再開します';

const MAX_LOADED = 6;     // 同時に持つモデルの数の上限（iPhoneのメモリ不足を避ける）。いま見ている図面の分は必ず持つ

let mindar = null;
let running = false;
let stages = [];         // 図面ごとの置き場所
let slots = [];          // 資料ごとのモデル
let active = null;       // いま見ている図面
let current = null;      // いま情報パネルに出している資料
let panel = null;
let catalog = null;
let preferred = null;    // QR や一覧で指定された資料
let pendingNote = null;  // リンクで指定された注記（レイヤーの uid.番号）
let seeThrough = false;
let shapeMode = false;
let tracking = { ...TRACKING_DEFAULTS };
const debug = new URLSearchParams(location.search).has('debug');

/* ---------- 図面と資料 ---------- */

function makeStage(target) {
  const anchor = mindar.addAnchor(target.index); // MindAR が出す生の姿勢（そのままでは細かく揺れる）
  const root = new THREE.Group();                // なめらかにした姿勢。モデルはこちらに入れる
  root.visible = false;
  mindar.scene.add(root);
  const st = { target, anchor, root, stabilizer: new PoseStabilizer(tracking), slots: [], usedAt: 0, toldTap: false };
  anchor.onTargetFound = () => onFound(st);
  anchor.onTargetLost = () => onLost(st);
  return st;
}

function makeSlot(st, item) {
  const place = new THREE.Group();   // 図面の上の置き場所
  place.position.copy(placePosition(item));
  place.visible = false;
  const user = new THREE.Group();    // 指での回転・拡大
  place.add(user);
  st.root.add(place);
  const slot = {
    item, stage: st, place, user, mode: displayMode(item),
    anchor: st.anchor, root: st.root, stabilizer: st.stabilizer, // 確認用の近道
    pose: null, model: null, annotations: null, meta: null, loading: null,
  };
  st.slots.push(slot);
  return slot;
}

function ensureLoaded(slot) {
  if (slot.model) return Promise.resolve(slot);
  if (slot.loading) return slot.loading;
  const { item } = slot;
  slot.loading = Promise.all([
    loadItemObject(item, (p) => { if (!active || active === slot.stage) showHint(`モデルを読み込み中… ${Math.round(p * 100)}%`); }),
    item.meta ? fetchJson(item.meta).catch(() => null) : null,
    loadAnnotationData(item).catch((err) => { console.warn(err); return null; }),
  ]).then(([model, meta, annoData]) => {
    const pose = buildPose(item, model);
    slot.user.add(pose);
    const annotations = buildAnnotations(annoData, model.maxDim);
    model.raw.add(annotations.group);
    model.setSeeThrough(seeThrough);
    if (shapeMode) model.setMode('shape');
    Object.assign(slot, { model, meta, annotations, pose, loading: null });
    slot.place.visible = true;
    return slot;
  }).catch((err) => {
    slot.loading = null;
    console.error(err);
    showHint(`モデルを読み込めません：${err.message}`);
    throw err;
  });
  return slot.loading;
}

// 見ていない図面のモデルから、古い順に捨てる
function releaseFor(keep) {
  const others = stages.filter((st) => st !== keep).sort((a, b) => a.usedAt - b.usedAt);
  const count = () => slots.filter((s) => s.model).length;
  for (const st of others) {
    for (const s of st.slots) {
      if (count() <= MAX_LOADED) return;
      if (!s.model || s === current) continue;
      s.user.remove(s.pose);
      s.annotations.dispose();
      s.model.dispose();
      s.model = s.annotations = s.pose = null;
      s.place.visible = false;
    }
  }
}

/* ---------- 認識の開始・終了 ---------- */

function select(slot) {
  if (!slot || !slot.model) return;
  if (current && current !== slot && current.annotations) current.annotations.select(null);
  current = slot;
  panel.setItem(slot.item, slot.meta);
  panel.setSiblings(slot.stage.slots.filter((s) => s.model).map((s) => s.item), slot.item);
  panel.setLayers(slot.annotations.layers);
  $('panel').hidden = false;
  if (pendingNote) {
    const entry = findEntry(slot.annotations, pendingNote);
    if (entry) { pendingNote = null; slot.annotations.select(entry); panel.showSelection(entry); }
  }
}

let flashTimer = null;
function flash(text, ms) {
  showHint(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (hint.textContent === text) showHint(''); }, ms);
}

function onFound(st) {
  $('recover').hidden = true;
  st.usedAt = performance.now();
  active = st;
  showHint('');
  Promise.allSettled(st.slots.map(ensureLoaded)).then(() => {
    if (active !== st) return;
    releaseFor(st);
    if (!current || current.stage !== st || !current.model) {
      const want = st.slots.find((s) => s.item === preferred && s.model) || st.slots.find((s) => s.model);
      select(want);
    }
    if (!st.anchor.visible) showHint(st.stabilizer.ready ? HOLD_HINT : SCAN_HINT);
    else if (st.slots.filter((s) => s.model).length > 1 && !st.toldTap) {
      st.toldTap = true;
      flash('モデルをたたくと資料を切り替えます', 3500);
    } else showHint('');
  });
}

function onLost(st) {
  // パネルは残す（図面から目を離しても情報を読み続けられるように）
  if (active !== st) return;
  showHint(tracking.hold && st.slots.some((s) => s.model) ? HOLD_HINT : SCAN_HINT);
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
    if (moved > 8 || !quick || !active || !active.root.visible) return;
    const dom = mindar.renderer.domElement;
    // 別のモデルをたたいたら、その資料に切り替える
    const hit = pickModel(e.clientX, e.clientY, dom, mindar.camera, active.slots);
    if (hit && hit !== current) select(hit);
    if (!current || !current.model) return;
    const entry = pickAnnotation(e.clientX, e.clientY, dom, mindar.camera, current.annotations, current.model);
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
  for (const st of stages) {
    const live = st.anchor.visible ? st.anchor.group.matrix : null;
    st.stabilizer.update(live, dt, now);
    st.root.visible = st === active && st.stabilizer.ready && st.slots.some((s) => s.model);
    if (st.root.visible) st.stabilizer.applyTo(st.root);
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
  stages.forEach((st) => { if (st.anchor.visible) controller.onUpdate({ type: 'updateMatrix', targetIndex: st.target.index, worldMatrix: null }); });
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
    `状態 ${t.state}${active && active.stabilizer.held ? '（固定表示）' : ''}`,
    `認識 ${t.fps.toFixed(1)}回/秒  描画 ${renderFps.toFixed(0)}回/秒`,
    `手がかり ${t.points}点（表示中の最少 ${Number.isFinite(t.minPointsSeen) ? t.minPointsSeen : '-'}）`,
    `発見 ${t.detections}  却下 ${t.rejected}`,
    `探索 ${Object.keys(t.tries).map((k) => `${k} ${t.hits[k] || 0}/${t.tries[k]}`).join('  ')}`,
    `探し直し ${t.fallbacks}  見失い ${t.lost}  作り直し ${heals}`,
    `エラー ${t.errors}${t.lastError ? ` ${t.lastError.slice(0, 40)}` : ''}${performance.now() - t.lastFrameAt > 2500 ? '  ※処理停止中' : ''}`,
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
    stages.forEach((st) => { st.stabilizer.reset(); st.anchor.visible = false; }); // 前の姿勢は捨てる
    await mindar.start();
    trackingStats.errorStreak = 0; trackingStats.lastFrameAt = performance.now();
    mindar.renderer.setAnimationLoop(render);
    running = true;
    showHint(SCAN_HINT);
  } catch (err) {
    showHint('カメラを再開できません。ページを読み込み直してください');
  }
}

async function start(preferredTarget) {
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
  stages = catalog.targets.map(makeStage);
  slots = catalog.items.map((it) => makeSlot(stages[it.targetIndex], it));

  try {
    await mindar.start();
  } catch (err) {
    throw new Error('カメラを起動できませんでした。ブラウザの設定でこのページのカメラ使用を許可してください。');
  }
  running = true;
  mindar.renderer.setAnimationLoop(render);
  setupGestures();

  // QRで図面や資料を指定して開いた場合は、認識を待たずにその図面のモデルを先に読み込んでおく
  const first = preferredTarget ? stages[preferredTarget.index] : null;
  if (first) Promise.allSettled(first.slots.map(ensureLoaded)).then(() => { if (!active) showHint(SCAN_HINT); });

  window.addEventListener('orientationchange', scheduleRestart);
  if (screen.orientation) screen.orientation.addEventListener('change', scheduleRestart);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !running) return;
    trackingStats.lastFrameAt = performance.now(); // 画面を離れていた時間を「処理が止まった」と数えない
    if (mindar.video && mindar.video.paused) mindar.video.play().catch(() => {});
  });
}

async function main() {
  catalog = await loadCatalog();
  preferred = itemFromQuery(catalog);
  const preferredTarget = (preferred && preferred.drawing) || targetFromQuery(catalog);
  pendingNote = new URLSearchParams(location.search).get('note');
  if (preferred) $('link-viewer').href = `viewer.html?id=${encodeURIComponent(preferred.id)}`;
  else if (preferredTarget && preferredTarget.items[0]) $('link-viewer').href = `viewer.html?id=${encodeURIComponent(preferredTarget.items[0].id)}`;
  if (isInAppBrowser()) $('inapp').hidden = false;

  panel = createPanel($('panel'), {
    onLayerToggle: (layer, on) => { layer.object.visible = on; },
    onClearSelection: () => { if (current && current.annotations) current.annotations.select(null); panel.showSelection(null); },
    onPickItem: (item) => select(slots.find((s) => s.item === item)),
    edition: catalog.site.edition,
    cite: catalog.site.cite,
  });

  // 表示の切り替えは、いま見ている図面のモデルすべてにかける
  const loaded = () => slots.filter((s) => s.model);
  $('btn-mode').addEventListener('click', () => {
    shapeMode = !shapeMode;
    loaded().forEach((s) => s.model.setMode(shapeMode ? 'shape' : 'photo'));
    $('btn-mode').setAttribute('aria-pressed', String(shapeMode));
  });
  $('btn-see').addEventListener('click', () => {
    seeThrough = !seeThrough;
    loaded().forEach((s) => s.model.setSeeThrough(seeThrough));
    $('btn-see').setAttribute('aria-pressed', String(seeThrough));
  });
  $('btn-rescan').addEventListener('click', () => (running ? restart() : location.reload()));
  $('btn-reset').addEventListener('click', () => {
    if (!active) return;
    for (const s of active.slots) { s.user.rotation.set(0, 0, 0); s.user.scale.setScalar(1); }
  });

  const startBtn = $('btn-start');
  const errorBox = $('gate-error');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = '準備中…';
    errorBox.hidden = true;
    try {
      await start(preferredTarget);
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

  window.__ar = { // 確認用
    get mindar() { return mindar; }, get stages() { return stages; }, get slots() { return slots; },
    get active() { return active; }, get current() { return current; }, select, restart, tracking, stats: trackingStats,
  };
}

main().catch((err) => {
  console.error(err);
  $('gate-error').textContent = `準備できません：${err.message}`;
  $('gate-error').hidden = false;
  $('btn-start').disabled = true;
});
