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
    this._key = NaN;
    this._flipSince = 0;
  }

  reset() { this.ready = false; this.held = false; }

  // matrix：MindAR が出した最新の姿勢（見失っているときは null）、dt：前の描画からの秒数、now：ミリ秒
  update(matrix, dt, now) {
    if (!matrix) {
      this.held = this.ready;
      if (!this.cfg.hold) this.ready = false;
      return;
    }
    const e = matrix.elements;
    const key = e[12] + e[13] * 3 + e[14] * 7 + e[0] * 11 + e[5] * 13 + e[9] * 17;
    const fresh = key !== this._key;   // 追跡は描画より遅いので、同じ姿勢が何コマか続く
    this._key = key;
    matrix.decompose(_p, _q, _s);

    if (!this.ready || this.held) {
      // 初回と、見失いからの復帰直後は、新しい姿勢へそのまま合わせる
      this.position.copy(_p); this.quaternion.copy(_q); this.scale.setScalar((_s.x + _s.y + _s.z) / 3);
      this._lastP.copy(_p); this._lastQ.copy(_q); this._lastAt = now;
      this._velP.set(0, 0, 0); this._velQ.set(0, 0, 0);
      this.ready = true; this.held = false; this._flipSince = 0;
      return;
    }
    // 大きさは本来一定（図面の幅）。生の値は軸ごとにわずかにばらつくので、平均してゆっくり合わせる
    const size = (_s.x + _s.y + _s.z) / 3;
    this.scale.setScalar(this.scale.x + (size - this.scale.x) * alpha(this.cfg.stillCutoff, dt));

    // 向きが一瞬だけ大きく跳ぶこと（平面の姿勢推定で起きる裏返り）があるので、
    // ならした向きから25°を超える変化は、0.25秒続くまで採用しない
    if (this.quaternion.angleTo(_q) > 0.44) {
      if (!this._flipSince) this._flipSince = now;
      if (now - this._flipSince < 250) return;
    } else {
      this._flipSince = 0;
    }

    if (fresh) {
      const gap = Math.max((now - this._lastAt) / 1000, 1 / 120);
      const a = alpha(this.cfg.speedCutoff, gap);
      // 位置の速さ：カメラからの距離で割り、見かけの角度で測る
      _v.copy(_p).sub(this._lastP).multiplyScalar(1 / (Math.max(_p.length(), 1e-6) * gap));
      this._velP.lerp(_v, a);
      // 向きの速さ：前回からの回転を、軸×角度のベクトルにして測る
      _dq.copy(this._lastQ).invert().premultiply(_q);
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
      const half = Math.acos(Math.min(1, _dq.w));
      const sin = Math.sin(half);
      const k = sin > 1e-6 ? (2 * half) / (sin * gap) : 0;
      _v.set(_dq.x * k, _dq.y * k, _dq.z * k);
      this._velQ.lerp(_v, a);
      this._lastP.copy(_p); this._lastQ.copy(_q); this._lastAt = now;
    }

    const { stillCutoff, posFollow, rotFollow } = this.cfg;
    this.position.lerp(_p, alpha(stillCutoff + posFollow * this._velP.length(), dt));
    this.quaternion.slerp(_q, alpha(stillCutoff + rotFollow * this._velQ.length(), dt));
  }

  applyTo(object) {
    object.position.copy(this.position);
    object.quaternion.copy(this.quaternion);
    object.scale.copy(this.scale);
  }
}
