// 追跡の安定化。MindAR の処理ループを差し替え、表示側で姿勢をなめらかにする。
//
// MindAR 既定の動きと、ここで変えている点：
//   既定  1コマでも追跡に失敗すると、図面を探し直す処理に戻る。探し直しで得る姿勢は粗いので、
//         追跡と探し直しを行き来するたびにモデルが跳ね、探し直しに数回失敗すると消える。
//   変更  追跡が一度軌道に乗ったあとは、失敗しても直前の姿勢から数コマ粘る。
//         手がかりが少なすぎるコマは姿勢の更新に使わない。
//         見失ったあとは最後の姿勢のまま表示を残す（表示側の PoseStabilizer）。
//   既定  追跡の処理の中で一度でも例外が出ると、処理全体が止まり、再読み込みするまで戻らない。
//   変更  例外はそのコマだけの失敗として扱い、次のコマから探し直す。
//
//   既定  図面を探す方法が正面に近い見え方を前提にしていて、斜めからだと見つからない。
//   変更  映像を「図面と正対したらこう見える」形に直してから探す方法を交互に挟む（oblique.js）。
import { Controller } from '../lib/mindar/mindar-image.prod.js';
import { tiltTowardTop, tiltTowardSide, facing, planeTilt, planWindow, renderWindow, poseFromWindow } from './oblique.js';

export const TRACKING_DEFAULTS = {
  minPoints: 6,        // 姿勢の更新に使う手がかりの最少数（MindAR既定は4。少ないと姿勢が暴れる）
  retryFrames: 8,      // 追跡に失敗しても、探し直しに戻らず粘るコマ数（MindAR既定は0）
  warmupTolerance: 2,  // 表示を始めるまでに必要な連続成功コマ数
  lostAfterMs: 800,    // 姿勢が得られない状態がこの時間（ミリ秒）続いたら「見失った」と判断する
  obliqueSearch: 1,    // 1＝斜めから見た図面も探す
  searchTilts: [50, 65],   // 斜めの探索で仮定する傾き（度）。図面の奥側が画面の上に来る向き（机の上の図面）
  searchSideTilts: [],     // 同上、奥側が画面の左右に来る向き（壁の図面を横から見る場合。例 [50]）
  stillCutoff: 0.5,    // 手を止めているときのならし方（Hz）。小さいほど揺れないが、動き出しが遅れる
  posFollow: 15,       // 位置：動きの速さに応じて追従を速める度合い
  rotFollow: 7,        // 向き：同上
  speedCutoff: 1.0,    // 動きの速さを見積もるときのならし方（Hz）
  hold: 1,             // 1＝見失っても最後の姿勢で表示を残す／0＝消す
  rejectOutliers: 1,   // 1＝周りと食い違う手がかり（取り違え）を姿勢の計算から外す
  cameraLongSide: 0,   // カメラ映像の長辺の希望画素数（0＝ブラウザ任せ）。例：640
  detectOnly: 0,       // 検証用：1＝探すだけで追跡に入らない
};

// 状態の記録（?debug=1 の表示と検証に使う）
export const trackingStats = {
  frames: 0, fps: 0, points: 0, used: 0, minPointsSeen: Infinity,
  state: '待機', detections: 0, fallbacks: 0, rejected: 0, lost: 0,
  tries: {}, hits: {},   // 探し方ごとの試行回数と成功回数（正面＝MindAR既定、傾50＝傾き50°を仮定、前回＝最後に追跡できた向き）
  lastWay: '', lastPose: null,
  errors: 0, errorStreak: 0, lastError: '', lastFrameAt: 0, _t0: 0, _n: 0,
};

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
let runToken = 0;

export function installTracking(cfg) {
  const stats = trackingStats;

  // 斜めの探索は MindAR が同梱する計算ライブラリを借りる。見つからなければ、斜めの探索だけをやめる
  if (cfg.obliqueSearch && !(window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.tf)) {
    console.warn('斜めの探索を無効にしました（MindAR の計算ライブラリが見つかりません）');
    cfg.obliqueSearch = 0;
  }

  // MindAR はカメラの大きさを指定せずに開くので、希望があればここで足す
  const media = navigator.mediaDevices;
  if (cfg.cameraLongSide > 0 && media && !media.__sized) {
    const open = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      if (constraints && constraints.video && typeof constraints.video === 'object') {
        constraints.video.width = { ideal: cfg.cameraLongSide };
        constraints.video.height = { ideal: Math.round(cfg.cameraLongSide * 0.75) };
      }
      return open(constraints);
    };
    media.__sized = true;
  }

  Controller.prototype.stopProcessVideo = function stopProcessVideo() {
    this.processingVideo = false;
    runToken += 1; // 止めた処理が、次に始めた処理と並んで走り続けないようにする
  };

  Controller.prototype.processVideo = function processVideo(input) {
    if (this.processingVideo) return;
    this.processingVideo = true;
    const token = ++runToken;
    const states = this.markerDimensions.map(() => ({
      showing: false, isTracking: false, locked: false, currentModelViewTransform: null, trackCount: 0, lastGoodAt: 0, failStreak: 0,
    }));
    this.trackingStates = states;
    stats._t0 = performance.now(); stats._n = 0; stats.errorStreak = 0; stats.lastFrameAt = performance.now();
    let detectTurn = 0;
    let lastNormal = null;   // 最後に追跡できていたときの図面の向き（斜めのときだけ覚える）
    let scratch = null;
    let scratchCtx = null;
    let windowPixels = null;

    // 斜めの探索で試す見え方の一覧。仮定する傾きと、画面のどこを見るかの組み合わせを順に回る
    const obliqueViews = () => {
      const kinds = [];
      if (lastNormal) kinds.push(['前回', facing(lastNormal)]);
      for (const d of cfg.searchTilts || []) kinds.push([`傾${d}`, tiltTowardTop(d)]);
      for (const d of cfg.searchSideTilts || []) { kinds.push([`右${d}`, tiltTowardSide(d)]); kinds.push([`左${d}`, tiltTowardSide(-d)]); }
      const views = [];
      // 図面は画面の中央に来ることが多いので、中央を多めに試す
      for (const y of [0.5, 0.5, 0.32, 0.5, 0.5, 0.68]) for (const [label, turn] of kinds) views.push({ label, turn, x: 0.5, y });
      return views;
    };

    // 映像を図面と正対する向きに直してから探す
    const searchOblique = async (view, candidates) => {
      const tf = window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.tf;
      const K = this.projectionTransform;
      const size = this.cropDetector.cropSize;
      const frame = this.inputLoader.context.canvas;   // loadInput がいまのコマを描いた直後の画像
      const k = Math.min(1, 640 / Math.max(frame.width, frame.height));
      const sw = Math.round(frame.width * k), sh = Math.round(frame.height * k);
      if (!scratch || scratch.width !== sw || scratch.height !== sh) {
        scratch = document.createElement('canvas'); scratch.width = sw; scratch.height = sh;
        scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
        windowPixels = new Float32Array(size * size);
      }
      scratchCtx.drawImage(frame, 0, 0, sw, sh);
      const rgba = scratchCtx.getImageData(0, 0, sw, sh).data;
      const { toCamera } = planWindow(K, this.inputWidth, view.turn, this.inputWidth * view.x, this.inputHeight * view.y, size);
      const toSource = [toCamera[0].map((v) => v * k), toCamera[1].map((v) => v * k), toCamera[2]];
      renderWindow(rgba, sw, sh, toSource, size, windowPixels);
      const imageT = tf.tensor(windowPixels, [size, size], 'float32');
      let featurePoints;
      try { featurePoints = this.cropDetector.detector.detect(imageT).featurePoints; } finally { imageT.dispose(); }
      const { targetIndex, modelViewTransform } = await this._workerMatch(featurePoints, candidates);
      return { targetIndex, modelViewTransform: targetIndex === -1 ? null : poseFromWindow(K, toCamera, modelViewTransform) };
    };

    const emit = (i, transform) => {
      let worldMatrix = null;
      if (transform) {
        worldMatrix = [...this._glModelViewMatrix(transform, i)];
        if (input.width === this.inputHeight && input.height === this.inputWidth) worldMatrix = this.getRotatedZ90Matrix(worldMatrix);
      }
      this.onUpdate && this.onUpdate({ type: 'updateMatrix', targetIndex: i, worldMatrix });
    };

    const step = async (inputT) => {
      // 図面を探す（追跡中の図面が上限に達していないときだけ）
      if (states.filter((s) => s.isTracking).length < this.maxTrack) {
        const candidates = [];
        states.forEach((s, i) => {
          if (!s.isTracking && (this.interestedTargetIndex === -1 || this.interestedTargetIndex === i)) candidates.push(i);
        });
        // 正面向けの探し方（MindAR既定）と、斜め向けの探し方を1コマおきに交互に使う
        const views = cfg.obliqueSearch && detectTurn % 2 === 1 ? obliqueViews() : [];
        const view = views.length ? views[(detectTurn >> 1) % views.length] : null;
        detectTurn += 1;
        const way = view ? view.label : '正面';
        const { targetIndex, modelViewTransform } = view
          ? await searchOblique(view, candidates)
          : await this._detectAndMatch(inputT, candidates);
        stats.tries[way] = (stats.tries[way] || 0) + 1;
        if (targetIndex !== -1) {
          stats.hits[way] = (stats.hits[way] || 0) + 1;
          stats.detections += 1;
          stats.lastWay = way; stats.lastPose = modelViewTransform;
          if (!cfg.detectOnly) {
            const s = states[targetIndex];
            s.isTracking = true; s.locked = false; s.currentModelViewTransform = modelViewTransform; s.failStreak = 0;
          }
        }
      }

      for (let i = 0; i < states.length; i++) {
        const s = states[i];
        let good = false;

        if (s.isTracking) {
          const { worldCoords, screenCoords } = this.tracker.track(inputT, s.currentModelViewTransform, i);
          stats.points = worldCoords.length;
          if (s.showing) stats.minPointsSeen = Math.min(stats.minPointsSeen, worldCoords.length);
          let next = null;
          let used = { worldCoords, screenCoords };
          if (cfg.rejectOutliers) used = consistentPoints(this.projectionTransform, s.currentModelViewTransform, worldCoords, screenCoords);
          stats.used = used.worldCoords.length;
          // 表示中は多めの手がかりを求める（揺れを抑える）。表示前は MindAR 既定の4点で受け付ける（早く復帰する）
          const need = s.showing ? cfg.minPoints : Math.min(cfg.minPoints, 4);
          if (used.worldCoords.length >= need) {
            next = await this._workerTrackUpdate(s.currentModelViewTransform, used);
          }
          if (next) {
            s.currentModelViewTransform = next; s.failStreak = 0; s.locked = true; good = true;
            const tilt = planeTilt(next);
            lastNormal = tilt.deg > 25 ? tilt.normal : null;   // 正面に近ければ、既定の探し方で足りる
          } else if (!s.locked) {
            // 探して得たばかりの姿勢で一度も追跡できなかった：その姿勢が粗いので、粘らずすぐ探し直す
            s.isTracking = false; stats.rejected += 1;
          } else {
            s.failStreak += 1;
            if (s.failStreak > cfg.retryFrames) { s.isTracking = false; stats.fallbacks += 1; }
          }
        }

        if (!s.showing) {
          s.trackCount = good ? s.trackCount + 1 : 0;
          if (s.trackCount > this.warmupTolerance) { s.showing = true; s.lastGoodAt = performance.now(); }
        }
        if (s.showing) {
          const t = performance.now();
          if (good) {
            s.lastGoodAt = t;
            emit(i, s.currentModelViewTransform);
          } else if (t - s.lastGoodAt > cfg.lostAfterMs) {
            // 端末によって処理の速さが違うので、コマ数ではなく時間で判断する
            s.showing = false; s.trackCount = 0; stats.lost += 1;
            emit(i, null);
          }
        }
      }

      const active = states.find((s) => s.showing);
      stats.state = active ? (active.failStreak ? '粘り中' : '追跡中') : (states.some((s) => s.isTracking) ? '確認中' : '探索中');
    };

    const run = async () => {
      while (this.processingVideo && token === runToken) {
        let inputT = null;
        try {
          inputT = this.inputLoader.loadInput(input);
          await step(inputT);
          stats.errorStreak = 0;
        } catch (err) {
          // 1コマの失敗で処理全体が止まらないようにする（止まると再読み込みするまで復帰しない）
          stats.errors += 1; stats.errorStreak += 1; stats.lastError = String((err && err.message) || err);
          states.forEach((s) => { s.isTracking = false; s.locked = false; s.failStreak = 0; });
        }
        try { if (inputT) inputT.dispose(); } catch (err) { /* 描画面が失われたときは破棄も失敗する */ }
        stats.frames += 1; stats._n += 1;
        const now = performance.now();
        stats.lastFrameAt = now;
        if (now - stats._t0 >= 1000) { stats.fps = (stats._n * 1000) / (now - stats._t0); stats._t0 = now; stats._n = 0; }
        this.onUpdate && this.onUpdate({ type: 'processDone' });
        await nextFrame();
      }
    };
    run();
  };
}

/* ---------- 取り違えた手がかりを外す ---------- */

// 1コマの間の動きは小さいので、手がかりの「前の姿勢からのずれ」は図面全体でなめらかに変わるはず。
// 全体の傾向（位置に対する一次式）から大きく外れた手がかりは、別の場所と取り違えたものとして捨てる。
// MindAR は合った手がかりをすべて同じ重みで使うので、取り違えが混じると姿勢が傾いたまま戻らないことがある
function consistentPoints(K, T, worldCoords, screenCoords) {
  const n = worldCoords.length;
  if (n < 8) return { worldCoords, screenCoords };
  const P = [0, 1, 2].map((r) => [0, 1, 3].map((c) => K[r][0] * T[0][c] + K[r][1] * T[1][c] + K[r][2] * T[2][c]));
  const dx = new Float64Array(n), dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const { x, y } = worldCoords[i];
    const w = P[2][0] * x + P[2][1] * y + P[2][2];
    dx[i] = screenCoords[i].x - (P[0][0] * x + P[0][1] * y + P[0][2]) / w;
    dy[i] = screenCoords[i].y - (P[1][0] * x + P[1][1] * y + P[1][2]) / w;
  }
  let keep = Array.from({ length: n }, (_, i) => i);
  for (let pass = 0; pass < 2; pass++) {
    // ずれ = a + b·x + c·y を、残っている手がかりで当てはめる
    let sx = 0, sy = 0;
    for (const i of keep) { sx += worldCoords[i].x; sy += worldCoords[i].y; }
    const mx = sx / keep.length, my = sy / keep.length;
    let xx = 0, xy = 0, yy = 0, xu = 0, yu = 0, xv = 0, yv = 0, su = 0, sv = 0;
    for (const i of keep) {
      const x = worldCoords[i].x - mx, y = worldCoords[i].y - my;
      xx += x * x; xy += x * y; yy += y * y; xu += x * dx[i]; yu += y * dx[i]; xv += x * dy[i]; yv += y * dy[i]; su += dx[i]; sv += dy[i];
    }
    const det = xx * yy - xy * xy;
    if (Math.abs(det) < 1e-9) break;
    const bu = (xu * yy - yu * xy) / det, cu = (yu * xx - xu * xy) / det, au = su / keep.length;
    const bv = (xv * yy - yv * xy) / det, cv = (yv * xx - xv * xy) / det, av = sv / keep.length;
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = worldCoords[i].x - mx, y = worldCoords[i].y - my;
      res[i] = Math.hypot(dx[i] - (au + bu * x + cu * y), dy[i] - (av + bv * x + cv * y));
    }
    const sorted = keep.map((i) => res[i]).sort((a, b) => a - b);
    const limit = Math.max(2.5 * sorted[Math.floor(sorted.length / 2)], 1.5); // 中央値の2.5倍、最低1.5画素
    const next = [];
    for (let i = 0; i < n; i++) if (res[i] <= limit) next.push(i);
    if (next.length < 6) break;
    keep = next;
  }
  return { worldCoords: keep.map((i) => worldCoords[i]), screenCoords: keep.map((i) => screenCoords[i]) };
}
