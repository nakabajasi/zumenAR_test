// 追跡の安定化。MindAR の処理ループを差し替え、表示側で姿勢をなめらかにする。
//
// MindAR 既定の動きと、ここで変えている点：
//   既定  1コマでも追跡に失敗すると、図面を探し直す処理に戻る。探し直しで得る姿勢は粗いので、
//         追跡と探し直しを行き来するたびにモデルが跳ね、探し直しに数回失敗すると消える。
//   変更  失敗しても直前の姿勢から数コマ粘る。手がかりが少なすぎるコマは姿勢の更新に使わない。
//         見失ったあとは最後の姿勢のまま表示を残す（表示側の PoseStabilizer）。
import { Controller } from '../lib/mindar/mindar-image.prod.js';

export const TRACKING_DEFAULTS = {
  minPoints: 6,        // 姿勢の更新に使う手がかりの最少数（MindAR既定は4。少ないと姿勢が暴れる）
  retryFrames: 8,      // 追跡に失敗しても、探し直しに戻らず粘るコマ数（MindAR既定は0）
  warmupTolerance: 2,  // 表示を始めるまでに必要な連続成功コマ数
  lostAfterMs: 800,    // 姿勢が得られない状態がこの時間（ミリ秒）続いたら「見失った」と判断する
  stillCutoff: 0.5,    // 手を止めているときのならし方（Hz）。小さいほど揺れないが、動き出しが遅れる
  posFollow: 15,       // 位置：動きの速さに応じて追従を速める度合い
  rotFollow: 7,        // 向き：同上
  speedCutoff: 1.0,    // 動きの速さを見積もるときのならし方（Hz）
  hold: 1,             // 1＝見失っても最後の姿勢で表示を残す／0＝消す
  rejectOutliers: 1,   // 1＝周りと食い違う手がかり（取り違え）を姿勢の計算から外す
  cameraLongSide: 0,   // カメラ映像の長辺の希望画素数（0＝ブラウザ任せ）。例：640
};

// 状態の記録（?debug=1 の表示と検証に使う）
export const trackingStats = {
  frames: 0, fps: 0, points: 0, used: 0, minPointsSeen: Infinity,
  state: '待機', detections: 0, fallbacks: 0, lost: 0, _t0: 0, _n: 0,
};

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function installTracking(cfg) {
  const stats = trackingStats;

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

  Controller.prototype.processVideo = function processVideo(input) {
    if (this.processingVideo) return;
    this.processingVideo = true;
    const states = this.markerDimensions.map(() => ({
      showing: false, isTracking: false, currentModelViewTransform: null, trackCount: 0, lastGoodAt: 0, failStreak: 0,
    }));
    this.trackingStates = states;
    stats._t0 = performance.now(); stats._n = 0;

    const emit = (i, transform) => {
      let worldMatrix = null;
      if (transform) {
        worldMatrix = [...this._glModelViewMatrix(transform, i)];
        if (input.width === this.inputHeight && input.height === this.inputWidth) worldMatrix = this.getRotatedZ90Matrix(worldMatrix);
      }
      this.onUpdate && this.onUpdate({ type: 'updateMatrix', targetIndex: i, worldMatrix });
    };

    const run = async () => {
      while (this.processingVideo) {
        const inputT = this.inputLoader.loadInput(input);

        // 図面を探す（追跡中の図面が上限に達していないときだけ）
        if (states.filter((s) => s.isTracking).length < this.maxTrack) {
          const candidates = [];
          states.forEach((s, i) => {
            if (!s.isTracking && (this.interestedTargetIndex === -1 || this.interestedTargetIndex === i)) candidates.push(i);
          });
          const { targetIndex, modelViewTransform } = await this._detectAndMatch(inputT, candidates);
          if (targetIndex !== -1) {
            const s = states[targetIndex];
            s.isTracking = true; s.currentModelViewTransform = modelViewTransform; s.failStreak = 0;
            stats.detections += 1;
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
            if (used.worldCoords.length >= cfg.minPoints) {
              next = await this._workerTrackUpdate(s.currentModelViewTransform, used);
            }
            if (next) {
              s.currentModelViewTransform = next; s.failStreak = 0; good = true;
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
        stats.frames += 1; stats._n += 1;
        const now = performance.now();
        if (now - stats._t0 >= 1000) { stats.fps = (stats._n * 1000) / (now - stats._t0); stats._t0 = now; stats._n = 0; }

        inputT.dispose();
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
