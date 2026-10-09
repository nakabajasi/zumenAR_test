// 表示側で姿勢をなめらかにする。MindAR が出す生の姿勢は細かく揺れ、見失うと消えるので、
// モデルはこの結果で動かす。
//
// 考え方：動きの速さを見て、ならす強さを変える。
//   手を止めている … 強くならす（揺れを止める）
//   動かしている   … 弱くならす（遅れずについてくる）
// 速さは1回ごとの差ではなく、ならした値で見る。1回ごとの差は揺れそのものなので、
// それで判断すると「揺れ＝動いている」と誤解して揺れを素通しにしてしまう。
import * as THREE from 'three';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _v = new THREE.Vector3();

const TWO_PI = Math.PI * 2;
const alpha = (cutoffHz, dt) => 1 - Math.exp(-TWO_PI * cutoffHz * dt);
const JUMP_ANGLE = THREE.MathUtils.degToRad(25);
const JUMP_MATCH_ANGLE = THREE.MathUtils.degToRad(15);
const JUMP_CONFIRM_MS = 250;
const JUMP_MAX_GAP_MS = 500;
const JUMP_MIN_SAMPLES = 3;

export class PoseStabilizer {
  constructor(cfg) {
    this.cfg = cfg;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.ready = false;     // 一度でも姿勢が得られたか
    this.held = false;      // 見失って、最後の姿勢のまま表示しているか
    this._lastP = new THREE.Vector3();    // 直前に受け取った生の姿勢
    this._lastQ = new THREE.Quaternion();
    this._lastAt = 0;
    this._velP = new THREE.Vector3();     // ならした速さ（位置：カメラから見た角度/秒、向き：ラジアン/秒）
    this._velQ = new THREE.Vector3();
    this._targetP = new THREE.Vector3();
    this._targetQ = new THREE.Quaternion();
    this._targetSize = 1;
    this._lastMatrix = null;
    this._sampleId = null;
    this._jumpQ = new THREE.Quaternion();
    this._jumpSince = 0;
    this._jumpLastAt = 0;
    this._jumpCount = 0;
  }

  reset() {
    this.ready = false; this.held = false;
    this._lastMatrix = null; this._sampleId = null; this._jumpCount = 0;
  }

  // sample：追跡が成功して届いた観測の { id, at }。描画を繰り返しても観測回数は増やさない。
  // sample省略時は行列オブジェクトの同一性を使う（MindARは更新ごとに新しい行列を渡す）。
  update(matrix, dt, now, sample = null) {
    if (!matrix) {
      this.held = this.ready;
      if (!this.cfg.hold) this.ready = false;
      this._jumpCount = 0;
      return;
    }
    const fresh = sample ? sample.id !== this._sampleId : matrix !== this._lastMatrix;
    const sampleAt = sample ? sample.at : now;
    if (fresh) {
      this._lastMatrix = matrix;
      this._sampleId = sample ? sample.id : null;
      matrix.decompose(_p, _q, _s);

      if (!this.ready || this.held) {
        // 初回・見失いからの復帰は、新たに追跡できた観測に合わせる。
        this._acceptTarget(sampleAt);
        this.position.copy(_p); this.quaternion.copy(_q); this.scale.setScalar(this._targetSize);
        this._velP.set(0, 0, 0); this._velQ.set(0, 0, 0);
        this.ready = true; this.held = false; this._jumpCount = 0;
        return;
      }

      // 大きな向きの変化は、近い向きの新しい観測が3回以上・250ms以上続いたときだけ採用。
      // 比較対象は最後に採用した向き。表示の補間遅れ自体を誤った急変と数えない。
      let accept = true;
      if (this._targetQ.angleTo(_q) > JUMP_ANGLE) {
        if (!this._jumpCount || sampleAt - this._jumpLastAt > JUMP_MAX_GAP_MS || this._jumpQ.angleTo(_q) > JUMP_MATCH_ANGLE) {
          this._jumpSince = sampleAt; this._jumpCount = 1;
        } else if (sampleAt > this._jumpLastAt) {
          this._jumpCount += 1;
        }
        this._jumpLastAt = sampleAt;
        this._jumpQ.copy(_q);
        accept = this._jumpCount >= JUMP_MIN_SAMPLES && sampleAt - this._jumpSince >= JUMP_CONFIRM_MS;
      } else {
        this._jumpCount = 0;
      }
      if (accept) {
        const gap = Math.max((sampleAt - this._lastAt) / 1000, 1 / 120);
        const a = alpha(this.cfg.speedCutoff, gap);
        _v.copy(_p).sub(this._lastP).multiplyScalar(1 / (Math.max(_p.length(), 1e-6) * gap));
        this._velP.lerp(_v, a);
        _dq.copy(this._lastQ).invert().premultiply(_q);
        if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
        const half = Math.acos(THREE.MathUtils.clamp(_dq.w, -1, 1));
        const sin = Math.sin(half);
        const k = sin > 1e-6 ? (2 * half) / (sin * gap) : 0;
        _v.set(_dq.x * k, _dq.y * k, _dq.z * k);
        this._velQ.lerp(_v, a);
        this._acceptTarget(sampleAt);
        this._jumpCount = 0;
      }
    }

    if (!this.ready || this.held) return;
    const { stillCutoff, posFollow, rotFollow } = this.cfg;
    // 描画の間は、採用済みの姿勢だけへ補間する。保留・却下した観測へは動かさない。
    this.scale.setScalar(this.scale.x + (this._targetSize - this.scale.x) * alpha(stillCutoff, dt));
    this.position.lerp(this._targetP, alpha(stillCutoff + posFollow * this._velP.length(), dt));
    this.quaternion.slerp(this._targetQ, alpha(stillCutoff + rotFollow * this._velQ.length(), dt));
  }

  _acceptTarget(at) {
    this._targetP.copy(_p); this._targetQ.copy(_q);
    this._targetSize = (_s.x + _s.y + _s.z) / 3;
    this._lastP.copy(_p); this._lastQ.copy(_q); this._lastAt = at;
  }

  applyTo(object) {
    object.position.copy(this.position);
    object.quaternion.copy(this.quaternion);
    object.scale.copy(this.scale);
  }
}
