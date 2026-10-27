// 紙面に対する姿勢の揺れを抑える。カメラ画像そのものの補正ではない。
// 観測時にだけフィルターを更新し、描画はその結果へ補間する。
import * as THREE from 'three';

const alpha=(hz,dt)=>1-Math.exp(-2*Math.PI*hz*dt);
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const value=(cfg,key,fallback)=>Number.isFinite(Number(cfg[key]))?Number(cfg[key]):fallback;
const p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();
const a=new THREE.Vector3(),b=new THREE.Vector3(),offset=new THREE.Vector3();
const inv=new THREE.Quaternion(),dq=new THREE.Quaternion(),velocity=new THREE.Vector3();
function coherence(history,step) {
  history.push(step.clone());if(history.length>4)history.shift();
  if(history.length<4)return 0;
  let x=0,y=0,z=0,path=0;
  for(const v of history){x+=v.x;y+=v.y;z+=v.z;path+=v.length();}
  return path>1e-6?clamp((Math.hypot(x,y,z)/path-.8)/.15,0,1):0;
}

// 同じ紙面上の点を基準に、位置と回転をならす。紙面中心が画面外でも回転で表示が流れにくい。
function blend(dstP,dstQ,dstS,goalP,goalQ,size,pivot,ap,ar,as) {
  a.copy(pivot).multiplyScalar(dstS.x).applyQuaternion(dstQ).add(dstP);
  b.copy(pivot).multiplyScalar(size).applyQuaternion(goalQ).add(goalP);
  a.lerp(b,ap);dstQ.slerp(goalQ,ar);dstS.setScalar(dstS.x+(size-dstS.x)*as);
  offset.copy(pivot).multiplyScalar(dstS.x).applyQuaternion(dstQ);
  dstP.copy(a).sub(offset);
}

export class PoseStabilizer {
  constructor(cfg,aspect=1) {
    this.cfg=cfg;this.aspect=Number.isFinite(aspect)&&aspect>0?aspect:1;
    this.position=new THREE.Vector3();this.quaternion=new THREE.Quaternion();this.scale=new THREE.Vector3(1,1,1);
    this._filteredP=new THREE.Vector3();this._filteredQ=new THREE.Quaternion();this._filteredS=new THREE.Vector3(1,1,1);
    this._lastP=new THREE.Vector3();this._lastQ=new THREE.Quaternion();this._lastSize=1;
    this._velP=new THREE.Vector3();this._velQ=new THREE.Vector3();this._pivot=new THREE.Vector3();
    this._pendingP=new THREE.Vector3();this._pendingQ=new THREE.Quaternion();
    this.diagnostics={state:'待機',samples:0,rejected:0,positionDelta:0,rotationDelta:0};
    this.reset();
  }

  reset() {
    this.ready=false;this.held=false;this._seenId=null;this._seenMatrix=null;this._lastAt=null;this._pending=null;
    this._posSteps=[];this._rotSteps=[];
    this._velP.set(0,0,0);this._velQ.set(0,0,0);this._pivot.set(0,0,0);
    this.diagnostics.state='待機';
  }

  // 光軸と紙面の交点を図面全体の座標で求める。図面外なら最も近い端に制限する。
  _choosePivot() {
    inv.copy(this._filteredQ).invert();
    a.copy(this._filteredP).negate().applyQuaternion(inv).divideScalar(this._filteredS.x);
    b.set(0,0,-1).applyQuaternion(inv);
    const t=-a.z/b.z;
    if (Math.abs(b.z)<0.15||!Number.isFinite(t)||t<=0) return;
    this._pivot.set(clamp(a.x+t*b.x,-.5,.5),clamp(a.y+t*b.y,-this.aspect/2,this.aspect/2),0);
  }

  _acceptInitial(size,at) {
    this.position.copy(p);this.quaternion.copy(q);this.scale.setScalar(size);
    this._filteredP.copy(p);this._filteredQ.copy(q);this._filteredS.setScalar(size);
    this._lastP.copy(p);this._lastQ.copy(q);this._lastSize=size;this._lastAt=at;
    this._velP.set(0,0,0);this._velQ.set(0,0,0);this._pending=null;
    this._posSteps=[];this._rotSteps=[];
    this.ready=true;this.held=false;this._choosePivot();this.diagnostics.state='補正中';
  }

  // sampleはanchor.onTargetUpdateごとの{id,at}。同じ行列でも新しい観測なら別の標本として扱う。
  update(matrix,dt,now,sample=null) {
    if (!matrix) {
      this.held=this.ready;if (!this.cfg.hold) this.ready=false;
      this._pending=null;this.diagnostics.state=this.held?'固定表示':'待機';return;
    }
    const fresh=!this.ready||this.held||(sample ? sample.id!==this._seenId
      : !this._seenMatrix||matrix.elements.some((v,i)=>v!==this._seenMatrix[i]));
    if (fresh) {
      this._seenId=sample?.id??null;this._seenMatrix=matrix.elements.slice();
      const at=Number.isFinite(sample?.at)?sample.at:now;
      matrix.decompose(p,q,s);
      const size=(s.x+s.y+s.z)/3;
      if (![p.x,p.y,p.z,q.x,q.y,q.z,q.w,size].every(Number.isFinite)||size<=0) {
        this.diagnostics.rejected++;this.diagnostics.state='不正な姿勢を除外';return;
      }
      this.diagnostics.samples++;
      if (!this.ready||this.held) {this._acceptInitial(size,at);return;}
      const gap=clamp((at-this._lastAt)/1000,1/120,.25);
      this._choosePivot();
      a.copy(this._pivot).multiplyScalar(this._filteredS.x).applyQuaternion(this._filteredQ).add(this._filteredP);
      b.copy(this._pivot).multiplyScalar(size).applyQuaternion(q).add(p);
      const depth=Math.max(Math.abs(a.z),Math.abs(b.z),1e-6);
      const delta=a.distanceTo(b)/depth,angle=this._filteredQ.angleTo(q);
      const screenDelta=Math.hypot(b.x/Math.max(Math.abs(b.z),1e-6)-a.x/Math.max(Math.abs(a.z),1e-6),
        b.y/Math.max(Math.abs(b.z),1e-6)-a.y/Math.max(Math.abs(a.z),1e-6));
      const depthDelta=Math.abs(a.z-b.z)/depth;
      this.diagnostics.positionDelta=delta*100;this.diagnostics.rotationDelta=angle*180/Math.PI;
      // 急変は3回以上の整合する新しい観測・250msの両方で確認。同じフレームの再描画は数えない。
      const jump=delta>Math.max(.12,this._velP.length()*gap*4)||angle>Math.max(.44,this._velQ.length()*gap*4);
      let confirmed=false;
      if (jump) {
        const same=this._pending&&at-this._pending.lastAt<400&&this._pendingP.distanceTo(p)/depth<.04&&this._pendingQ.angleTo(q)<.2;
        if (!same) {this._pending={at,lastAt:at,count:1};this._pendingP.copy(p);this._pendingQ.copy(q);}
        else {this._pending.count++;this._pending.lastAt=at;}
        confirmed=this._pending.count>=3&&at-this._pending.at>=250;
        if (!confirmed) {this.diagnostics.rejected++;this.diagnostics.state='急変を確認中';return;}
      }
      this._pending=null;
      // 符号付きの速度をならす。往復する手ぶれを一方向の移動速度として増幅しない。
      a.copy(this._pivot).multiplyScalar(this._lastSize).applyQuaternion(this._lastQ).add(this._lastP);
      b.copy(this._pivot).multiplyScalar(size).applyQuaternion(q).add(p);
      velocity.copy(b).sub(a).divideScalar(depth*gap);
      const posCoherent=coherence(this._posSteps,velocity);
      const speedAlpha=alpha(Math.max(.1,value(this.cfg,'speedCutoff',1)),gap);
      this._velP.lerp(velocity,speedAlpha);
      dq.copy(this._lastQ).invert().premultiply(q);if(dq.w<0)dq.set(-dq.x,-dq.y,-dq.z,-dq.w);
      const half=Math.acos(clamp(dq.w,-1,1)),sin=Math.sin(half),k=sin>1e-6?2*half/(sin*gap):0;
      velocity.set(dq.x*k,dq.y*k,dq.z*k);
      const rotCoherent=coherence(this._rotSteps,velocity);this._velQ.lerp(velocity,speedAlpha);
      const base=Math.max(.05,value(this.cfg,'stillCutoff',.25));
      // 微小な往復では速度推定の残りを増幅しない。偏差が蓄積する実際の移動では追従を速める。
      const posMotion=Math.max(posCoherent,clamp((screenDelta-.005)/.015,0,1),clamp((depthDelta-.035)/.07,0,1));
      const rotMotion=Math.max(rotCoherent,clamp((angle-.035)/.10,0,1));
      const posHz=base+2*Math.max(0,value(this.cfg,'posFollow',15))*Math.max(0,this._velP.length()-(.025-.02*posCoherent))*posMotion;
      const rotHz=base+4*Math.max(0,value(this.cfg,'rotFollow',7))*Math.max(0,this._velQ.length()-(.035-.025*rotCoherent))*rotMotion;
      blend(this._filteredP,this._filteredQ,this._filteredS,p,q,size,this._pivot,
        alpha(confirmed?Math.max(5,posHz):posHz,gap),alpha(confirmed?Math.max(5,rotHz):rotHz,gap),alpha(base,gap));
      this._lastP.copy(p);this._lastQ.copy(q);this._lastSize=size;this._lastAt=at;
      this.diagnostics.state=posHz>base+.5||rotHz>base+.5?'移動に追従':'手ぶれ抑制';
    }
    if (!this.ready) return;
    // 描画回数を認識回数として数えない。表示だけを短く補間し、認識停止中は先へ予測しない。
    const renderAlpha=alpha(20,clamp(dt,0,.1));
    blend(this.position,this.quaternion,this.scale,this._filteredP,this._filteredQ,this._filteredS.x,this._pivot,renderAlpha,renderAlpha,renderAlpha);
  }

  applyTo(object) {object.position.copy(this.position);object.quaternion.copy(this.quaternion);object.scale.copy(this.scale);}
}
