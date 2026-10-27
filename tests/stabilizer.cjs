// node --experimental-vm-modules --no-warnings tests/stabilizer.cjs [--baseline 更新前ZIP]
// 描画・姿勢補正は実コード、姿勢観測は合成。カメラ・画像認識の実測ではない。
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
 const context=vm.createContext({console});
 const three=new vm.SourceTextModule(fs.readFileSync(root+'/lib/three.module.min.js','utf8'),{context});await three.link(()=>{});await three.evaluate();
 const T=three.namespace;
 async function load(src){const m=new vm.SourceTextModule(src,{context});await m.link(()=>three);await m.evaluate();return m.namespace.PoseStabilizer;}
 const Filter=await load(fs.readFileSync(root+'/js/stabilizer.js','utf8'));
 const defaults=(src)=>vm.runInContext('('+src.match(/export const TRACKING_DEFAULTS = (\{[\s\S]*?\n\});/)[1]+')',context);
 const cfg=defaults(fs.readFileSync(root+'/js/tracking.js','utf8'));
 const pose=(x=0,y=0,z=-.5,rx=0,ry=0)=>new T.Matrix4().compose(new T.Vector3(x,y,z),new T.Quaternion().setFromEuler(new T.Euler(rx,ry,0)),new T.Vector3(1,1,1));
 const update=(f,m,id,at)=>f.update(m,1/60,at,{id,at});
 const base=pose();
 for(const bad of [pose(.3),pose(0,0,-.5,Math.PI/3)]) {
  const f=new Filter(cfg);update(f,base,1,0);update(f,bad,2,100);
  for(let i=1;i<=120;i++)f.update(bad,1/60,100+i*1000/60,{id:2,at:100});
  assert(f.position.distanceTo(new T.Vector3(0,0,-.5))<1e-9);
  assert(f.quaternion.angleTo(new T.Quaternion())<1e-9,'同じ誤観測の再描画で位置・回転を採用しない');
  update(f,base,3,2200);assert.equal(f.diagnostics.state,'手ぶれ抑制');
 }
 const change=new Filter(cfg);update(change,base,1,0);
 for(const [id,at] of [[2,100],[3,250],[4,400]])update(change,pose(0,0,-.5,Math.PI/3),id,at);
 for(let i=0;i<60;i++)change.update(pose(0,0,-.5,Math.PI/3),1/60,410+i*16.7,{id:4,at:400});
 assert(change.quaternion.angleTo(new T.Quaternion().setFromEuler(new T.Euler(Math.PI/3,0,0)))<.03,'新しい整合する観測で実際の大きな傾きに復帰する');
 const contradict=new Filter(cfg);update(contradict,base,1,0);
 for(let i=1;i<12;i++)update(contradict,pose(0,0,-.5,(i%2?1:-1)*Math.PI/3),i+1,i*100);
 assert(contradict.quaternion.angleTo(new T.Quaternion())<1e-9);
 const lost=new Filter(cfg);update(lost,base,1,0);lost.update(null,1/60,100);assert(lost.held);
 update(lost,base,2,200);assert(lost.ready&&!lost.held);
 lost.reset();update(lost,pose(.1),3,300);assert.equal(lost.position.x,.1);
 const noHold=new Filter({...cfg,hold:0});update(noHold,base,1,0);noHold.update(null,1/60,100);assert(!noHold.ready);
 const invalid=new Filter(cfg);update(invalid,base,1,0);const nan=base.clone();nan.elements[12]=NaN;update(invalid,nan,2,100);
 assert.equal(invalid.position.x,0);assert.equal(invalid.diagnostics.rejected,1);
 const legacy=new Filter(cfg);legacy.update(base,1/60,0);legacy.update(null,1/60,100);legacy.update(base,1/60,200);assert(!legacy.held);
 const still=new Filter(cfg);for(let i=0;i<100;i++)update(still,pose(-.35,-.2,-.5),i,i*100);
 assert(still.position.distanceTo(new T.Vector3(-.35,-.2,-.5))<1e-12,'静止中に座標が徐々にずれない');assert.equal(still.scale.x,1);
 // 実際のARのanchor通知とrenderを実行。同じ行列でも新しい認識通知を別標本として渡す。
 const ar=fs.readFileSync(root+'/js/ar.js','utf8'),anchor={visible:true,group:{matrix:base.clone()}},clock={now:100};
 const ui=vm.createContext({THREE:T,PoseStabilizer:Filter,tracking:cfg,performance:{now:()=>clock.now},
   mindar:{addAnchor:()=>anchor,scene:{add(){}},renderer:{render(){}}},onFound(){},onLost(){},
   syncLineResolution(){},watchdog(){},debug:false,lastRender:0});
 vm.runInContext(ar.slice(ar.indexOf('function makeStage('),ar.indexOf('\nfunction makeSlot(')),ui);
 ui.stages=[ui.makeStage({index:0,widthPx:3969,heightPx:2807})];ui.active=ui.stages[0];ui.active.slots=[{model:{}}];
 vm.runInContext(ar.slice(ar.indexOf('function render(now)'),ar.indexOf('// 端末',ar.indexOf('function render(now)'))).split('// 端末')[0].split('// ?debug=1')[0].split('// 追跡の処理')[0],ui);
 anchor.onTargetUpdate();ui.render(100);ui.render(110);
 assert.equal(ui.active.stabilizer.diagnostics.samples,1);
 clock.now=200;anchor.onTargetUpdate();ui.render(200);assert.equal(ui.active.stabilizer.diagnostics.samples,2);
 anchor.visible=false;anchor.onTargetUpdate();ui.render(300);assert(ui.active.stabilizer.held);
 anchor.visible=true;clock.now=400;anchor.onTargetUpdate();ui.render(400);assert(!ui.active.stabilizer.held);
 const pixel=(f)=>{const v=new T.Vector3(.4,.24,.04).applyMatrix4(new T.Matrix4().compose(f.position,f.quaternion,f.scale));return [600*v.x/-v.z,600*v.y/-v.z];};
 function simulate(C,hz,kind,render=60,seed0=123,settings=cfg) {
  const f=new C({...settings},.707),err=[];
  let observed=null,sample=null,id=0,next=0,seed=seed0;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/4294967296-.5)*2;};
  for(let frame=0;frame<render*8;frame++) {
   const t=frame/render,truth=pose(-.35+(kind==='pan'?Math.max(0,t-1)*.08:kind==='slow'?Math.max(0,t-1)*.01:0),-.2,
     kind==='approach'?-.8+Math.min(6,Math.max(0,t-1))*.06:-.5,0,kind==='turn'?Math.max(0,t-1)*.12:0);
   if(t+1e-9>=next){observed=truth.clone();if(kind==='jitter')observed=pose(-.35+noise()*.003,-.2+noise()*.003,-.5+noise()*.004,noise()*.026,noise()*.026);sample={id:++id,at:t*1000};next+=1/hz;}
   f.update(observed,1/render,t*1000,sample);
   const actual=pixel(f),v=new T.Vector3(.4,.24,.04).applyMatrix4(truth),expected=[600*v.x/-v.z,600*v.y/-v.z];
   if(t>2)err.push(Math.hypot(actual[0]-expected[0],actual[1]-expected[1]));
  }
  return {rms:Math.sqrt(err.reduce((s,e)=>s+e*e,0)/err.length),max:Math.max(...err),filtered:[...(f._filteredP||f.position).toArray(),...(f._filteredQ||f.quaternion).toArray()]};
 }
 let Old=null,oldCfg=null;
 const i=process.argv.indexOf('--baseline');
 if(i>=0){
  const readZip=(name)=>cp.execFileSync('python3',['-c','import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',process.argv[i+1],name],{encoding:'utf8'});
  Old=await load(readZip('js/stabilizer.js'));oldCfg=defaults(readZip('js/tracking.js'));
 }
 const results=[];
 for(const hz of [5,10,20])for(const kind of ['jitter','pan','slow','approach','turn']) {
  const seeds=kind==='jitter'?[1,123,2026]:[123];
  const average=(C,settings)=>{
   const all=seeds.map(seed=>simulate(C,hz,kind,60,seed,settings));
   return {rms:all.reduce((s,x)=>s+x.rms,0)/all.length,max:Math.max(...all.map(x=>x.max))};
  };
  const current=average(Filter,cfg),previous=Old?average(Old,oldCfg):null;
  assert(current.rms<(kind==='pan'?16:kind==='slow'?6:kind==='jitter'?3:5),`${hz}Hz ${kind}: ${current.rms}`);
  if(previous&&kind==='jitter')assert(current.rms<previous.rms*.85,'異なるノイズ列でも静止中の揺れが減る');
  results.push({hz,kind,previous,current});
 }
 for(const fps of [30,120]) {
  const a=simulate(Filter,10,'jitter',60),b=simulate(Filter,10,'jitter',fps);
  a.filtered.forEach((v,i)=>assert(Math.abs(v-b.filtered[i])<1e-9,'認識回数が同じなら描画FPSに関係なく補正結果は同じ'));
 }
 // 同じ静止補正Hzで閾値だけを変え、追加設定が実際の揺れの抑制に効くことを確認。
 const thresholds=[1,2,3].map(motionThreshold=>{
  const runs=[5,10,20].flatMap(hz=>[1,123,2026].map(seed=>simulate(Filter,hz,'jitter',60,seed,{...cfg,motionThreshold})));
  return {motionThreshold,rms:runs.reduce((sum,x)=>sum+x.rms,0)/runs.length};
 });
 assert(thresholds[1].rms<thresholds[0].rms&&thresholds[2].rms<thresholds[1].rms,'閾値を上げると模擬静止入力の揺れが減る');
 console.log(JSON.stringify(results,null,2));
 console.log(JSON.stringify({thresholds}));
 console.log('PASS: 静止ノイズ・横移動・低速移動・接近・旋回・一過性急変・同じ観測・実際の急変・見失い復帰・不正値・描画FPS独立性');
})().catch(e=>{console.error(e);process.exitCode=1;});
