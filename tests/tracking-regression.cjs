// Node.js: node --experimental-vm-modules tests/tracking-regression.cjs
// 実際の追跡制御・揺れ止めを読み込む。カメラ、GPU、Workerの画像解析部分は模擬入力。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const pose = [[1,0,0,0],[0,1,0,0],[0,0,1,100]];
const coords = [{x:0,y:0},{x:10,y:0},{x:0,y:10},{x:10,y:10},{x:20,y:10},{x:10,y:20},{x:20,y:20},{x:30,y:10}];
const input = {width:640,height:480};

async function runtime(count = () => 6, settings = {}) {
  const clock = {now:1}, raf = [], events = [], searches = [];
  let disposedInputs = 0, tracks = 0;
  class Controller {}
  const context = vm.createContext({console,window:{},navigator:{},performance:{now:()=>clock.now},requestAnimationFrame:cb=>raf.push(cb)});
  const stub = new vm.SyntheticModule(['Controller'], function(){this.setExport('Controller',Controller);},{context});
  const oblique = new vm.SourceTextModule(source('js/oblique.js'),{context});
  await oblique.link(()=>{throw Error('Unexpected import');});
  const module = new vm.SourceTextModule(source('js/tracking.js'),{context});
  await module.link(name=>name.includes('mindar-image.prod')?stub:oblique);
  await module.evaluate();
  const cfg = {...module.namespace.TRACKING_DEFAULTS,obliqueSearch:0,rejectOutliers:0,...settings};
  module.namespace.installTracking(cfg);
  const c = new Controller();
  Object.assign(c,{
    markerDimensions:[[1847,1238]],maxTrack:1,interestedTargetIndex:-1,warmupTolerance:cfg.warmupTolerance,
    inputWidth:640,inputHeight:480,projectionTransform:[[500,0,320],[0,500,240],[0,0,1]],
    inputLoader:{loadInput:()=>({dispose(){disposedInputs++;}})},
    _detectAndMatch:async()=>{searches.push(clock.now);return {targetIndex:0,modelViewTransform:pose};},
    tracker:{track:()=>{const n=count(tracks++);return {worldCoords:coords.slice(0,n),screenCoords:coords.slice(0,n)};}},
    _workerTrackUpdate:async()=>pose,
    _glModelViewMatrix:()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-100,1],
    onUpdate:e=>events.push({type:e.type,visible:!!e.worldMatrix,time:clock.now}),
  });
  return {c,cfg,clock,events,searches,stats:module.namespace.trackingStats,
    disposedInputs:()=>disposedInputs,
    async start(){c.processVideo(input);await flush();},
    async tick(at){clock.now=at;raf.shift()?.(at);await flush();},
    stop(){c.stopProcessVideo();},
  };
}

async function trackingTests() {
  for(const n of [5,6]) {
    const r=await runtime(()=>n);await r.start();
    for(let i=1;i<40;i++)await r.tick(1+i*100);
    r.stop();
    const visible=r.events.filter(e=>e.type==='updateMatrix'&&e.visible);
    assert.equal(r.stats.errors,0);
    assert.equal(r.stats.lost,0);
    if(n===5)assert.equal(visible.length,0,'点数不足で表示・消失を繰り返さない');
    else {assert.equal(visible.length,39);assert.equal(r.searches.length,1);}
  }
  const custom=await runtime(()=>6,{minPoints:8});await custom.start();
  await custom.tick(101);custom.stop();
  assert.equal(custom.events.some(e=>e.visible),false,'設定した必要点数は開始にも適用する');

  for(const fps of [5,10,20]) {
    const r=await runtime(n=>n<3?6:0);await r.start();
    for(let i=1;i<30;i++)await r.tick(1+i*1000/fps);
    r.stop();
    const lastGood=r.events.filter(e=>e.type==='updateMatrix'&&e.visible).at(-1).time;
    const delay=r.searches[1]-lastGood;
    assert(delay>=r.cfg.retryAfterMs-0.001);
    assert(delay<=r.cfg.retryAfterMs+1000/fps+0.001,'再探索は期限後の次のコマまでに始まる');
    console.log(`再探索 ${fps}回/秒: ${Math.round(delay)}ms`);
  }
  const brief=await runtime(n=>n===3?0:6);await brief.start();
  for(let i=1;i<10;i++)await brief.tick(1+i*100);
  brief.stop();assert.equal(brief.stats.fallbacks,0);assert.equal(brief.stats.lost,0);

  for(const phase of ['match','pose']) {
    const r=await runtime();let complete;
    if(phase==='match')r.c._detectAndMatch=()=>new Promise(resolve=>complete=resolve);
    else r.c._workerTrackUpdate=()=>new Promise(resolve=>complete=resolve);
    await r.start();r.stop();
    complete(phase==='match'?{targetIndex:0,modelViewTransform:pose}:pose);
    await flush();
    assert.equal(r.events.length,0,'停止後の結果・完了通知を出さない');
    assert.equal(r.disposedInputs(),1,'停止中の入力も破棄する');
  }
}

async function poseTests() {
  const context=vm.createContext({console,window:{}});
  const three=new vm.SourceTextModule(source('lib/three.module.min.js'),{context});
  await three.link(()=>{throw Error('Unexpected import');});
  const module=new vm.SourceTextModule(source('js/stabilizer.js'),{context});
  await module.link(()=>three);await module.evaluate();
  const T=three.namespace;
  const make=(hold=1)=>new module.namespace.PoseStabilizer({hold,stillCutoff:0.5,posFollow:15,rotFollow:7,speedCutoff:1});
  const matrix=(degrees)=>new T.Matrix4().makeRotationX(degrees*Math.PI/180).setPosition(0,0,-3);
  const degrees=f=>f.quaternion.angleTo(new T.Quaternion())*180/Math.PI;
  const f=make();
  f.update(matrix(0),1/60,0,{id:1,at:0});
  for(let i=1;i<=40;i++)f.update(matrix(60),1/60,i*1000/60,{id:2,at:10});
  assert(degrees(f)<1e-6,'同じ観測を再描画しても誤姿勢を採用しない');
  f.reset();f.update(matrix(0),1/60,0,{id:1,at:0});
  for(const [id,at] of [[2,10],[3,160],[4,310]])f.update(matrix(60),1/60,at,{id,at});
  for(let i=1;i<=60;i++)f.update(matrix(60),1/60,310+i*1000/60,{id:4,at:310});
  assert(degrees(f)>59,'新しい同じ向きの観測が続けば実際の向きの変更へ追従する');

  const alternating=make();alternating.update(matrix(0),1/60,0,{id:0,at:0});
  for(let i=1;i<=10;i++)alternating.update(matrix(i%2?60:-60),1/60,i*150,{id:i,at:i*150});
  assert(degrees(alternating)<1e-6,'食い違う急変をまとめて肯定しない');

  const moving=make();moving.update(matrix(0),1/60,0,{id:0,at:0});
  for(let i=1;i<=30;i++)moving.update(matrix(i*3),1/30,i*1000/30,{id:i,at:i*1000/30});
  assert(degrees(moving)>80,'連続的な動きは保留され続けない');
  for(const hold of [0,1]) {
    const lost=make(hold);lost.update(matrix(0),1/60,0,{id:0,at:0});
    lost.update(null,1/60,100);
    assert.equal(lost.ready,!!hold);
    lost.update(matrix(45),1/60,200,{id:1,at:200});
    assert(lost.ready&&!lost.held);assert(Math.abs(degrees(lost)-45)<1e-6);
  }
}

async function lifecycleTest() {
  const module=new vm.SourceTextModule(source('js/controller-lifecycle.js'),{context:vm.createContext({})});
  await module.link(()=>{throw Error('Unexpected import');});await module.evaluate();
  const r=await runtime();let terminated=0,disposedCaches=0,disposedPixels=0;
  r.c.worker={terminate(){terminated++;}};
  r.c._detectAndMatch=()=>new Promise(resolve=>r.c.workerMatchDone=resolve);
  r.c.inputLoader.tempPixelHandle={dataId:{}};
  await r.start();
  const tf={dispose(){disposedCaches++;},backend:()=>({disposeData(){disposedPixels++;}})};
  module.namespace.disposeController(r.c,tf);
  module.namespace.disposeController(r.c,tf);
  await r.c._trackingRunPromise;
  assert.equal(terminated,1);assert.equal(disposedCaches,1);assert.equal(disposedPixels,1);
  assert.equal(r.disposedInputs(),1);assert.equal(r.events.length,0);
}

(async()=>{
  await trackingTests();await poseTests();await lifecycleTest();
  console.log('PASS: 追跡条件、時間制限、短い失敗、停止後の結果、観測確認、復帰、旧Worker破棄');
})().catch(err=>{console.error(err);process.exitCode=1;});
