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
//
//   既定  追い続けるときに比べる図面の見本が1種類（短辺128画素の粗いもの）だけ。近づいて図面の一部を
//         大きく写すと、見本1画素に映像の何画素もが対応して細い線が拾えなくなり、すぐ見失う。
//   変更  細かさの違う見本を何段か持ち、図面が画面にどれくらいの大きさで写っているかで使い分ける。
//         細かい見本は all.mind に入っていればそれを、無ければ図面画像から作る（addTrackingLevels）。
//         あわせて、直前の動きから次の位置を見込んでから探す（近いと1コマの動きが大きく見えるため）。
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
  multiLevel: 1,       // 1＝近づいたら細かい見本に切り替える
  levelRatio: 3,       // 見本1画素に映像の何画素が対応するのがよいか。大きいと速い動きに強いが、細い線を拾えなくなる
  predict: 1,          // 1＝速く動かしているときは、直前の動き（画面の上での横・縦のずれ）から次の位置を見込んで探す
  stallMs: 3000,       // 1コマの処理がこの時間を超えたら、止まったとみなして追跡を作り直す
  resumeMs: 5000,      // 見失ってからこの時間は、図面を探すのと交互に「最後に追えていた位置」でも確かめる
};

// あとから足す細かい見本（図面ごと）。図面画像から作ったものが届いたら、次のコマから使う
const extraLevels = new Map();
let levelsVersion = 0;
export function addTrackingLevels(targetIndex, keyframes) {
  extraLevels.set(targetIndex, [...(extraLevels.get(targetIndex) || []), ...keyframes]);
  levelsVersion += 1;
}

// 状態の記録（?debug=1 の表示と検証に使う）
export const trackingStats = {
  frames: 0, fps: 0, points: 0, used: 0, minPointsSeen: Infinity,
  state: '待機', detections: 0, fallbacks: 0, rejected: 0, lost: 0,
  tries: {}, hits: {},   // 探し方ごとの試行回数と成功回数（正面＝MindAR既定、傾50＝傾き50°を仮定、前回＝最後に追跡できた向き）
  level: '', levels: '', retries: 0, tryLog: [], px: 0,   // いま使っている見本の細かさ（短辺の画素数）、持っている見本、やり直した回数
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
      level: -1, motion: null, goodFrame: -10, lastGoodT: null, resuming: false,
    }));
    let frameNo = 0;

    /* 見本の段：図面ごとに、粗い順。0 段目が MindAR 標準の見本 */
    const Tracker = this.tracker.constructor;
    const K = this.projectionTransform;
    // 作り直し（探し直す・処理が止まったときの再開）のたびに作ると計算の準備をやり直すことになるので、図面の読み込みごとに1回だけ作る
    let levels = null, builtVersion = -1;
    const buildLevels = () => {
      const cache = this.__levels;
      if (cache && cache.version === levelsVersion && cache.tracker === this.tracker) {
        levels = cache.levels; builtVersion = levelsVersion;
        stats.levels = levels.map((l) => l.map((lv) => lv.size).join('/')).join(' ');
        return;
      }
      for (const list of (cache && cache.levels) || []) for (const lv of list) if (lv.own) disposeTracker(lv.own);
      levels = this.markerDimensions.map((dims, i) => {
        const data = this.tracker.trackingDataList[i];
        const std = data[1] || data[0];
        const out = [{ size: Math.min(std.width, std.height), scale: std.scale, track: (inputT, T) => this.tracker.track(inputT, T, i) }];
        if (!cfg.multiLevel) return out;
        const finer = [...data, ...(extraLevels.get(i) || [])]
          .filter((k) => k !== std && k.width > std.width * 1.4 && k.points.length >= 30)
          .sort((a, b) => a.width - b.width);
        for (const k of finer) {
          if (out.length && k.width < out[out.length - 1].width * 1.4) continue; // 細かさがほぼ同じ段は1つにする
          const t = new Tracker([dims], [[k, k]], K, this.inputWidth, this.inputHeight);
          out.push({ size: Math.min(k.width, k.height), width: k.width, scale: k.scale, own: t, warm: false, track: (inputT, T) => t.track(inputT, T, 0) });
        }
        out[0].width = std.width;
        return out;
      });
      builtVersion = levelsVersion;
      this.__levels = { version: levelsVersion, tracker: this.tracker, levels };
      stats.levels = levels.map((l) => l.map((lv) => lv.size).join('/')).join(' ');
      states.forEach((s) => { s.level = -1; });
    };
    // 図面を探しているあいだに、まだ使っていない段の計算の準備を1つずつ済ませておく（追跡中に初めて使うと、そのコマが遅れる）
    const warmOne = (inputT) => {
      for (const list of levels) for (const lv of list) if (lv.own && !lv.warm) { lv.own.dummyRun(inputT); lv.warm = true; return; }
    };

    // 図面が画面に写っている大きさ：画面の中央（図面の外なら図面のいちばん近い所）で、図面の1画素が映像の何画素になるか
    const pixelScale = (T, dims) => {
      const Hm = [0, 1, 2].map((r) => [0, 1, 3].map((c) => K[r][0] * T[0][c] + K[r][1] * T[1][c] + K[r][2] * T[2][c]));
      const map = (M, x, y) => { const w = M[2][0] * x + M[2][1] * y + M[2][2]; return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w]; };
      const inv = invert3(Hm);
      if (!inv) return 0;
      let [u, v] = map(inv, this.inputWidth / 2, this.inputHeight / 2);
      u = Math.min(Math.max(u, 0), dims[0]); v = Math.min(Math.max(v, 0), dims[1]);
      const a = map(Hm, u, v), b = map(Hm, u + 1, v), c = map(Hm, u, v + 1);
      return Math.sqrt(Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])));
    };
    // 使う段を選ぶ。見本1画素あたりの映像の画素数が levelRatio に近い段。行ったり来たりしないよう、差が小さければ今の段のまま
    const pickLevel = (i, T, current = -1) => {
      const list = levels[i];
      if (list.length === 1) return 0;
      const px = pixelScale(T, this.markerDimensions[i]);
      stats.px = px;
      if (!px) return Math.max(current, 0);
      const cost = (lv) => Math.abs(Math.log(px / lv.scale / cfg.levelRatio));
      let best = current >= 0 ? current : 0;
      const keep = current >= 0 ? 0.1 : 0;
      list.forEach((lv, k) => { if (cost(lv) < cost(list[best]) - keep) best = k; });
      return best;
    };
    // その段で探す範囲（±10画素）が、映像の何画素にあたるか
    const reachPx = (i, k, T) => 10 * pixelScale(T, this.markerDimensions[i]) / levels[i][k].scale;

    // 1つの段で、姿勢 T のまわりに図面の目印を探す
    const trackAt = (i, k, inputT, T) => {
      const lv = levels[i][k];
      if (lv.own && !lv.warm) { lv.own.dummyRun(inputT); lv.warm = true; } // 初めて使う段は、計算の準備を先に済ませる
      const { worldCoords, screenCoords } = lv.track(inputT, T);
      const used = cfg.rejectOutliers ? consistentPoints(this.projectionTransform, T, worldCoords, screenCoords) : { worldCoords, screenCoords };
      return { used, raw: worldCoords.length, T, k };
    };

    // 見つけたばかりの姿勢（または最後に追えていた姿勢）を、粗い段から順に追い込む。
    // 近くで見ているときに探して得た姿勢は数十画素ずれていることがあり、細かい段では一度に合わせきれない
    const settle = async (i, inputT, T0, need) => {
      let T = T0, k = -1, last = null;
      for (let n = 0; n < 3; n++) {
        const pick = pickLevel(i, T);
        k = n === 0 ? Math.max(0, pick - 1) : pick;
        const r = trackAt(i, k, inputT, T);
        stats.tryLog = [...(n ? stats.tryLog : []), `${levels[i][k].size}合:${r.raw}/${r.used.worldCoords.length}`];
        if (r.used.worldCoords.length < need) break;
        const next = await this._workerTrackUpdate(T, r.used);
        if (!next) break;
        last = { ...r, next };
        T = next;
        if (n >= 1 && k === pick) break;   // 選んだ段で合ったら終わり
      }
      return last;
    };

    // 直前の動き（1コマあたりの、画面の中央の点の横・縦のずれ）が続くと見込んだ姿勢。
    // 向きや奥行きの変化まで見込むと、推定の小さな揺れを大きくしてしまうので、画面の上での平行な動きだけを見込む。
    // 追跡に失敗したコマが1つ挟まっても、その分だけ先へ進める
    const predicted = (s) => {
      if (!cfg.predict || !s.motion) return null;
      const n = frameNo - s.goodFrame;
      if (n < 1 || n > 2) return null;
      return shiftPose(s.currentModelViewTransform, s.motion[0] * n * 0.8, s.motion[1] * n * 0.8, K);
    };
    // 画面の中央に写っている図面の点が、姿勢 A から B で画面の上をどう動いたか（[横, 縦]、映像の画素）
    const centerMotion = (i, A, B) => {
      const dims = this.markerDimensions[i];
      const H = (T) => [0, 1, 2].map((r) => [0, 1, 3].map((c) => K[r][0] * T[0][c] + K[r][1] * T[1][c] + K[r][2] * T[2][c]));
      const map = (M, x, y) => { const w = M[2][0] * x + M[2][1] * y + M[2][2]; return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w]; };
      const inv = invert3(H(B));
      if (!inv) return [0, 0];
      let [u, v] = map(inv, this.inputWidth / 2, this.inputHeight / 2);
      u = Math.min(Math.max(u, 0), dims[0]); v = Math.min(Math.max(v, 0), dims[1]);
      const a = map(H(A), u, v), b = map(H(B), u, v);
      return [b[0] - a[0], b[1] - a[1]];
    };
    const centerShift = (i, A, B) => {
      const dims = this.markerDimensions[i];
      const H = (T) => [0, 1, 2].map((r) => [0, 1, 3].map((c) => K[r][0] * T[0][c] + K[r][1] * T[1][c] + K[r][2] * T[2][c]));
      const map = (M, x, y) => { const w = M[2][0] * x + M[2][1] * y + M[2][2]; return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w]; };
      const inv = invert3(H(B));
      if (!inv) return 0;
      let [u, v] = map(inv, this.inputWidth / 2, this.inputHeight / 2);
      u = Math.min(Math.max(u, 0), dims[0]); v = Math.min(Math.max(v, 0), dims[1]);
      const a = map(H(A), u, v), b = map(H(B), u, v);
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
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
      frameNo += 1;
      if (builtVersion !== levelsVersion || !levels) buildLevels();
      if (!states.some((s) => s.isTracking)) warmOne(inputT);
      // 図面を探す（追跡中の図面が上限に達していないときだけ）
      if (states.filter((s) => s.isTracking).length < this.maxTrack) {
        const candidates = [];
        states.forEach((s, i) => {
          if (!s.isTracking && (this.interestedTargetIndex === -1 || this.interestedTargetIndex === i)) candidates.push(i);
        });
        // 見失ってすぐなら、3回に1回は「最後に追えていた位置」のまま確かめる（近くで見ているときは、探すより見つかりやすい）
        const now = performance.now();
        const resume = candidates.find((i) => states[i].lastGoodT && now - states[i].lastGoodAt < cfg.resumeMs);
        const tryResume = resume !== undefined && detectTurn % 3 === 2;
        // 正面向けの探し方（MindAR既定）と、斜め向けの探し方を1コマおきに交互に使う
        const views = !tryResume && cfg.obliqueSearch && detectTurn % 2 === 1 ? obliqueViews() : [];
        const view = views.length ? views[(detectTurn >> 1) % views.length] : null;
        detectTurn += 1;
        const way = tryResume ? '直前の位置' : view ? view.label : '正面';
        const { targetIndex, modelViewTransform } = tryResume
          ? { targetIndex: resume, modelViewTransform: states[resume].lastGoodT }
          : view
            ? await searchOblique(view, candidates)
            : await this._detectAndMatch(inputT, candidates);
        stats.tries[way] = (stats.tries[way] || 0) + 1;
        if (targetIndex !== -1) {
          if (!tryResume) { stats.hits[way] = (stats.hits[way] || 0) + 1; stats.detections += 1; }
          stats.lastWay = way; stats.lastPose = modelViewTransform;
          if (!cfg.detectOnly) {
            const s = states[targetIndex];
            s.isTracking = true; s.locked = false; s.currentModelViewTransform = modelViewTransform; s.failStreak = 0;
            s.level = -1; s.motion = null; s.resuming = tryResume;   // 見つけた姿勢の大きさから段を選び直す
          }
        }
      }

      for (let i = 0; i < states.length; i++) {
        const s = states[i];
        let good = false;

        if (s.isTracking) {
          // 表示中は多めの手がかりを求める（揺れを抑える）。表示前は MindAR 既定の4点で受け付ける（早く復帰する）
          const need = s.showing ? cfg.minPoints : Math.min(cfg.minPoints, 4);
          const list = levels[i];
          let best = null, next = null;
          if (!s.locked) {
            // 見つけたばかり：粗い段から順に追い込む
            best = await settle(i, inputT, s.currentModelViewTransform, need);
            if (best) { next = best.next; s.level = best.k; if (s.resuming) stats.hits['直前の位置'] = (stats.hits['直前の位置'] || 0) + 1; }
          } else {
            s.level = pickLevel(i, s.currentModelViewTransform, s.level);
            // 速く動かしているとき（直前の動きが探す範囲の3割を超える）は、動きを見込んだ位置から先に探す。
            // 手を止めているときに見込むと、手の震えを大きくするだけなので、見込みは失敗したときの予備にする
            const guess = predicted(s);
            const fast = guess && centerShift(i, s.currentModelViewTransform, guess) > 0.3 * reachPx(i, s.level, s.currentModelViewTransform);
            const tries = [];
            if (fast) tries.push([s.level, guess]);
            tries.push([s.level, s.currentModelViewTransform]);
            if (guess && !fast) tries.push([s.level, guess]);
            if (s.level > 0) tries.push([s.level - 1, guess || s.currentModelViewTransform]);
            for (let n = 0; n < tries.length; n++) {
              const r = trackAt(i, tries[n][0], inputT, tries[n][1]);
              stats.tryLog = [...(n ? stats.tryLog : []), `${list[r.k].size}${r.T === guess ? '予' : ''}:${r.raw}/${r.used.worldCoords.length}`];
              if (!best || r.used.worldCoords.length > best.used.worldCoords.length) best = r;
              if (r.used.worldCoords.length >= need) break;
              if (n + 1 < tries.length) stats.retries += 1;
            }
            if (best.used.worldCoords.length >= need) next = await this._workerTrackUpdate(best.T, best.used);
          }
          if (best) {
            stats.points = best.raw; stats.used = best.used.worldCoords.length; stats.level = list[best.k].size;
            if (s.showing) stats.minPointsSeen = Math.min(stats.minPointsSeen, best.raw);
          } else { stats.points = 0; stats.used = 0; }
          s.resuming = false;
          if (next) {
            // 1コマあたりの動きを覚える（失敗したコマを挟んだときは、その数で割る）
            const gap = frameNo - s.goodFrame;
            s.motion = s.locked && gap >= 1 && gap <= 2 ? centerMotion(i, s.currentModelViewTransform, next).map((v) => v / gap) : null;
            s.goodFrame = frameNo;
            s.currentModelViewTransform = next; s.failStreak = 0; s.locked = true; good = true;
            s.lastGoodT = next;
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

/* ---------- 行列の小道具 ---------- */

function invert3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, k] = m[2];
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * k - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * k - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// 姿勢を、画面の上で横 dx・縦 dy 画素だけ平行にずらす（奥行きはそのまま）
function shiftPose(P, dx, dy, K) {
  const z = P[2][3];
  return [
    [P[0][0], P[0][1], P[0][2], P[0][3] + (dx * z) / K[0][0]],
    [P[1][0], P[1][1], P[1][2], P[1][3] + (dy * z) / K[1][1]],
    P[2].slice(),
  ];
}

// 足した見本の追跡器が持つ計算用のデータを捨てる（MindAR の追跡器には捨てる処理がない）
function disposeTracker(t) {
  for (const key of ['featurePointsListT', 'imagePixelsListT', 'imagePropertiesListT']) {
    for (const x of t[key] || []) { try { x.dispose(); } catch (err) { /* すでに捨ててある */ } }
  }
}
