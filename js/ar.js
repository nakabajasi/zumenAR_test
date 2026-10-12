// AR表示。図面（認識対象）ごとに置き場所を用意し、認識できた図面のモデルだけを読み込む
import * as THREE from 'three';
// 読み込む順番に意味がある：tracking.js が先。MindAR の2つのファイルはどちらも window.MINDAR.IMAGE に
// 部品を登録するが、tracking.js が使う側は丸ごと置き換え、下の three 用は追記する。逆順だと追記分が消える
import { TRACKING_DEFAULTS, trackingStats, installTracking } from './tracking.js?rev=partial-tracking-1';
import { MindARThree } from '../lib/mindar/mindar-image-three.prod.js';
import {
  url, loadCatalog, itemFromQuery, fetchJson, isInAppBrowser, loadItemObject, addLights,
  buildAnnotations, pickAnnotation, syncLineResolution,
} from './common.js?rev=drawing-auto-dimensions-1';
import { createDrawingPlacements, blenderBounds } from './placement.js?rev=drawing-auto-dimensions-1';
import { loadDrawingTargets } from './drawing-targets.js?rev=drawing-auto-dimensions-1';
import { createPanel } from './panel.js?rev=drawing-auto-dimensions-1';
import { PoseStabilizer } from './stabilizer.js?rev=tracking-fix-20261009';
import { disposeController } from './controller-lifecycle.js?rev=partial-tracking-1';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const hint = $('hint');
const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };
// 図面は近いほど見つけやすい（擬似映像での成功率：画面いっぱい約9割、画面幅の半分では約3割）
const SCAN_HINT = 'まず図面全体を映し、認識後はゆっくり近づけてください';
const HOLD_HINT = '図面を見失いました。少し離れて図面全体を映し直してください';
const KEEP_LOADED = 2;   // 同時に持つモデルの数。iPhoneのメモリ不足を避ける

let mindar = null;
let targetDataUrl = null; // 探し直しでも、配置を検証したものと同じ認識データを使う。
let running = false;
let slots = [];
let current = null;      // いま情報パネルに出している資料
let panel = null;
let tracking = { ...TRACKING_DEFAULTS };
let debug = new URLSearchParams(location.search).has('debug');

/* ---------- 置き方 ---------- */

function makeSlot(item, placement) {
  const anchor = mindar.addAnchor(item.targetIndex); // MindAR が出す生の姿勢（そのままでは細かく揺れる）
  const root = new THREE.Group();   // なめらかにした姿勢。モデルはこちらに入れる
  root.visible = false;
  const place = placement.group;   // 図面左下＝Blender原点。入力した実寸で大きさを決める
  root.add(place);
  mindar.scene.add(root);
  const slot = {
    item, anchor, root, place, placement, stabilizer: new PoseStabilizer(tracking),
    sample: { id: 0, at: 0 },
    model: null, annotations: null, meta: null, bounds: null, loading: null, usedAt: 0,
  };
  anchor.onTargetFound = () => onFound(slot);
  anchor.onTargetLost = () => onLost(slot);
  anchor.onTargetUpdate = () => {
    if (anchor.visible) { slot.sample.id += 1; slot.sample.at = performance.now(); }
  };
  return slot;
}

function ensureLoaded(slot) {
  if (slot.model) return Promise.resolve(slot);
  if (slot.loading) return slot.loading;
  const { item } = slot;
  slot.loading = Promise.all([
    loadItemObject(item, (p) => { if (current === slot || !current) showHint(`モデルを読み込み中… ${Math.round(p * 100)}%`); }, { preservePlacement: true }),
    item.meta ? fetchJson(item.meta).catch(() => null) : null,
    item.annotations ? fetchJson(item.annotations).catch(() => null) : null,
  ]).then(([model, meta, annoData]) => {
    const bounds = blenderBounds(model, slot.placement.coordinateSystem);
    slot.place.add(model.unit);
    const annotations = buildAnnotations(annoData, model.maxDim);
    model.raw.add(annotations.group);
    Object.assign(slot, { model, meta, annotations, bounds, loading: null });
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
    s.place.remove(s.model.unit);
    s.annotations.dispose();
    s.model.dispose();
    s.model = s.annotations = s.bounds = null;
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

/* ---------- アノテーションのタップ選択 ---------- */

// モデルの位置・向き・倍率は制作時の設定に従う。指では変更しない。
function setupAnnotationTaps() {
  const pointers = new Set();
  let tap = null;

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.add(e.pointerId);
    tap = pointers.size === 1
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, slot: current }
      : null;
  });

  stage.addEventListener('pointermove', (e) => {
    if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap = null;
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const candidate = tap;
    tap = null;
    if (e.type !== 'pointerup' || !candidate || candidate.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - candidate.x, e.clientY - candidate.y);
    const quick = e.timeStamp - candidate.t < 400; // 処理が混んでいても、指が触れた時刻そのもので比べる
    if (moved > 8 || !quick || current !== candidate.slot || !current || !current.model || !current.root.visible) return;
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
    slot.stabilizer.update(live, dt, now, slot.sample);
    slot.root.visible = slot === current && !!slot.model && slot.stabilizer.ready;
    if (slot.root.visible) slot.stabilizer.applyTo(slot.root);
  }
  syncLineResolution(mindar.renderer);
  mindar.renderer.render(mindar.scene, mindar.camera);
  watchdog(now);
  if (debug) updateDebug(now);
}

// 追跡が止まったときは、旧Workerを終了してからカメラと追跡を作り直す。
// 同じWorkerへ新しい要求を重ねると、遅れて届いた古い返答を取り違えるため再利用しない。
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
  restart();
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
  const b = current && current.bounds;
  const range = (axis) => b ? `${b.min[axis].toFixed(3)}〜${b.max[axis].toFixed(3)}` : '-';
  const dimensions = current ? `${Number(current.placement.width.toPrecision(8))} × ${Number(current.placement.height.toPrecision(8))} m` : '-';
  debugBox.hidden = false;
  debugBox.textContent = [
    '追跡修正 2026-10-09',
    '部分追跡 2026-10-12',
    '実寸設定 2026-10-11：画像左下＝Blender原点',
    `画像寸法 自動取得（all.mind） ${current ? `${current.placement.widthPx} × ${current.placement.heightPx} px` : '-'}`,
    `図面全体 幅×高さ ${dimensions}`,
    `軸 ${current ? current.placement.coordinateSystem : '-'} / 縦横比差 ${current ? (current.placement.aspectError * 100).toFixed(3) : '-'}%`,
    `モデル範囲 X ${range('x')}  Y ${range('y')}  Z ${range('z')}`,
    `状態 ${t.state}${current && current.stabilizer.held ? '（固定表示）' : ''}`,
    `認識 ${t.fps.toFixed(1)}回/秒  描画 ${renderFps.toFixed(0)}回/秒`,
    `手がかり ${t.points}点 → 採用 ${t.used}点 / 必要 ${tracking.minPoints}点`,
    `追跡方式 ${t.trackingMode} / 局所復帰 ${t.localRecoveries}回`,
    `近接候補 ${t.localCandidates}点 / 視野内 ${t.localVisible}点 / 登録 ${t.localRegistered}点`,
    `最終姿勢から ${t.lastPoseAt == null ? '-' : Math.round(now - t.lastPoseAt)}ms`,
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
    disposeController(mindar.controller);
    slots.forEach((s) => {
      s.stabilizer.reset(); s.anchor.visible = false; s.anchor.group.visible = false; s.root.visible = false;
    });
    mindar.renderer.render(mindar.scene, mindar.camera);
    await mindar.start();
    trackingStats.errorStreak = 0; trackingStats.lastFrameAt = performance.now();
    mindar.renderer.setAnimationLoop(render);
    running = true;
    showHint(SCAN_HINT);
  } catch (err) {
    showHint('カメラを再開できません。ページを読み込み直してください');
    $('recover').hidden = false;
  }
}

async function start(catalog, preferred) {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザではカメラを使えません。SafariかChromeで開いてください。');
  }
  stage.innerHTML = ''; // やり直しのときに前回の映像・描画面を残さない
  // 設定ミスはカメラや追跡用リソースを作る前に起動画面へ返す。
  const targets = await loadDrawingTargets(url('targets/all.mind'));
  const placements = createDrawingPlacements(catalog.items, targets.dimensions);

  // 追跡の設定：既定値 ← 台帳の tracking ← URL（例 ar.html?debug=1&stillCutoff=0.3）
  Object.assign(tracking, catalog.tracking || {});
  const query = new URLSearchParams(location.search);
  for (const key of Object.keys(TRACKING_DEFAULTS)) {
    if (!Array.isArray(TRACKING_DEFAULTS[key]) && query.has(key) && Number.isFinite(Number(query.get(key)))) tracking[key] = Number(query.get(key));
  }
  installTracking(tracking);

  if (targetDataUrl) URL.revokeObjectURL(targetDataUrl);
  targetDataUrl = URL.createObjectURL(new Blob([targets.buffer], { type: 'application/octet-stream' }));
  // 通信で再取得せず、寸法を確認した同じバイト列をMindARへ渡す。
  try {
    mindar = new MindARThree({
      container: stage,
      imageTargetSrc: targetDataUrl,
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
    slots = catalog.items.map((item, index) => makeSlot(item, placements[index]));

    await mindar.start();
  } catch (err) {
    mindar?.renderer.setAnimationLoop(null);
    mindar?.video?.srcObject?.getTracks().forEach((track) => track.stop());
    mindar?.video?.remove();
    disposeController(mindar?.controller);
    mindar?.renderer.dispose();
    mindar = null;
    URL.revokeObjectURL(targetDataUrl);
    targetDataUrl = null;
    throw new Error('カメラを起動できませんでした。ブラウザの設定でこのページのカメラ使用を許可してください。');
  }
  running = true;
  mindar.renderer.setAnimationLoop(render);
  setupAnnotationTaps();

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
  $('check-debug').checked = debug;
  $('check-debug').addEventListener('change', (e) => {
    debug = e.target.checked;
    if (debugBox) debugBox.hidden = !debug;
  });

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
