// node --experimental-vm-modules --no-warnings tests/local-tracking.cjs
// 実際の認識データと制御コード。GPU照合と姿勢Workerのみ模擬。
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const flush=()=>new Promise(r=>setImmediate(r));
const K=[[600,0,320],[0,600,240],[0,0,1]];
const project=(T,p)=>{const z=T[2][0]*p.x+T[2][1]*p.y+T[2][3];return {x:600*(T[0][0]*p.x+T[0][1]*p.y+T[0][3])/z+320,y:600*(T[1][0]*p.x+T[1][1]*p.y+T[1][3])/z+240};};

function modules(extra={}) {
 const context=vm.createContext({console,window:{},navigator:{userAgent:'Node'},URL,Blob,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,Uint8Array,Float32Array,ArrayBuffer,...extra});
 const cache=new Map();
 const load=p=>{p=path.resolve(p.split('?')[0]);if(!cache.has(p))cache.set(p,new vm.SourceTextModule(fs.readFileSync(p,'utf8'),{context,identifier:p}));return cache.get(p);};
 return {context,load,link:(s,r)=>load(path.resolve(path.dirname(r.identifier),s))};
}

async function runtime(data,options={}) {
 const clock={now:1},raf=[],events=[],control={empty:false,limit:64,successSizes:[1296]},memory={allocated:0,disposed:0,constructed:0},calls=[];
 const tensor=(data,shape)=>{memory.allocated++;return {data,shape,dead:false,dispose(){assert(!this.dead,'二重破棄しない');this.dead=true;memory.disposed++;}};};
 const tf={tensor,dispose:items=>items.flat(Infinity).forEach(t=>t.dispose())};
 class Native {
   constructor(dims,lists) {
     memory.constructed++;this.trackingDataList=lists;this.trackingKeyframeList=lists.map(l=>l[1]);
     this.featurePointsListT=lists.map(l=>tensor([], [l[1].points.length,2]));
     this.imagePixelsListT=lists.map(l=>tensor(l[1].data,[]));this.imagePropertiesListT=lists.map(l=>tensor([],[]));
   }
   dummyRun() {}
   track(input,T,index) {
     const f=this.trackingKeyframeList[index],size=Math.min(f.width,f.height);
     calls.push({size,count:f.points.length});
     if(control.empty||!control.successSizes.includes(size))return {worldCoords:[],screenCoords:[]};
     assert.equal(this.featurePointsListT[index].shape[0],64,'近接のGPU枠は64で固定');
     const points=f.points.slice(0,control.limit);
     const worldCoords=points.map((p,i)=>{
       assert(Math.abs(this.featurePointsListT[index].data[i*2]-p.x/f.scale)<.001);
       return {x:p.x/f.scale,y:p.y/f.scale,z:0};
     });
     return {worldCoords,screenCoords:worldCoords.map(p=>project(T,p))};
   }
 }
 class Controller {}
 const m=modules({window:{MINDAR:{IMAGE:{tf}}},performance:{now:()=>clock.now},requestAnimationFrame:fn=>raf.push(fn)});
 const stub=new vm.SyntheticModule(['Controller'],function(){this.setExport('Controller',Controller);},{context:m.context});
 const tracking=m.load(path.join(root,'js/tracking.js'));
 await tracking.link((s,r)=>s.includes('mindar-image.prod')?stub:m.link(s,r));await tracking.evaluate();
 const cfg={...tracking.namespace.TRACKING_DEFAULTS,obliqueSearch:0,...options};tracking.namespace.installTracking(cfg);
 const dims=[data.targetImage.width,data.targetImage.height],T=[[1,0,0,-dims[0]*.37],[0,1,0,-dims[1]*.45],[0,0,1,600*dims[0]*.1/640]];
 const c=new Controller();let searches=0,disposedInputs=0;
 Object.assign(c,{markerDimensions:[dims],tracker:new Native([dims],[data.trackingData]),projectionTransform:K,inputWidth:640,inputHeight:480,
   maxTrack:1,interestedTargetIndex:-1,warmupTolerance:cfg.warmupTolerance,
   inputLoader:{loadInput:()=>({dispose(){disposedInputs++;}})},
   _detectAndMatch:async()=>searches++===0?{targetIndex:0,modelViewTransform:T}:{targetIndex:-1,modelViewTransform:null},
   _workerTrackUpdate:async()=>T,_glModelViewMatrix:()=>Array(16).fill(1),onUpdate:e=>events.push(e)});
 return {c,T,cfg,control,clock,calls,memory,events,tracking,disposedInputs:()=>disposedInputs,
   async start(){c.processVideo({width:640,height:480});await flush();},
   async tick(t){clock.now=t;raf.shift()?.(t);await flush();},
   async stop(){c.stopProcessVideo();tracking.namespace.releaseTrackingLevels(c);await flush();},
 };
}

(async()=>{
 const m=modules(),compiler=m.load(path.join(root,'lib/mindar/mindar-image.prod.js'));
 await compiler.link(m.link);await compiler.evaluate();
 const data=new compiler.namespace.Compiler().importData(fs.readFileSync(path.join(root,'data/all.mind')))[0];
 const local=m.load(path.join(root,'js/local-tracker.js'));await local.link(m.link);await local.evaluate();
 const {selectVisible,hasSpread}=local.namespace;
 assert.deepEqual(Array.from(data.trackingData.slice(2),f=>Math.min(f.width,f.height)),[256,384,576,864,1296]);
 const fine=data.trackingData.at(-1);
 assert(fine.points.length>=500);
 const r=await runtime(data);await r.start();await r.tick(101);
 assert.equal(r.tracking.namespace.trackingStats.errors,0,r.tracking.namespace.trackingStats.lastError);
 assert(r.events.some(e=>e.worldMatrix),'粗い見本の照合失敗後にも細かい見本で追跡を開始する');
 assert(r.calls.some(c=>c.size===864)&&r.calls.some(c=>c.size===1296));
 assert.equal(r.tracking.namespace.trackingStats.level,1296);
 const selected=selectVisible(fine,K,r.T,640,480);
 assert(selected.points.length>=12&&selected.points.length<=64);
 assert(hasSpread(selected.points.map(p=>project(r.T,{x:p.x/fine.scale,y:p.y/fine.scale})),640,480));
 assert(!hasSpread(Array.from({length:8},(_,i)=>({x:i*30,y:i*30})),640,480));
 assert(!hasSpread(Array.from({length:8},()=>({x:300,y:200})),640,480));
 assert.equal(selectVisible(fine,K,[[1,0,0,1e6],[0,1,0,1e6],[0,0,1,1000]],640,480).points.length,0);
 const before=r.memory.constructed;
 r.tracking.namespace.addTrackingLevels(0,[{...fine,points:fine.points.slice()}]);await r.tick(201);
 assert.equal(r.memory.constructed,before+1,'見本の1段追加で他のGPUを再作成しない');
 assert.equal(r.memory.allocated-r.memory.disposed,18,'通常＋近接5段の保持量は増殖しない');
 r.control.empty=true;
 for(let i=3;i<=14;i++)await r.tick(i*100+1);
 const visibleBefore=r.events.filter(e=>e.worldMatrix).length;
 r.control.empty=false;
 for(let i=15;i<=20;i++)await r.tick(i*100+1);
 assert(r.events.filter(e=>e.worldMatrix).length>visibleBefore,'全体の再認識なしに局所照合で復帰する');
 assert(r.tracking.namespace.trackingStats.hits['直前の位置']>0);
 await r.stop();r.tracking.namespace.releaseTrackingLevels(r.c);
 assert.equal(r.memory.allocated-r.memory.disposed,3,'近接GPUは停止・再起動時に解放できる');

 const poseRetry=await runtime(data);await poseRetry.start();await poseRetry.tick(101);
 poseRetry.control.successSizes=[864,1296];
 poseRetry.c.trackingStates[0].level=4;poseRetry.c.trackingStates[0].levelUntil=999;
 poseRetry.c._workerTrackUpdate=async()=>poseRetry.calls.at(-1).size===1296?poseRetry.T:null;
 await poseRetry.tick(201);
 assert.equal(poseRetry.tracking.namespace.trackingStats.level,1296,'点が合っても姿勢計算に失敗したら次の段を試す');
 assert.equal(poseRetry.c.trackingStates[0].failStreak,0);await poseRetry.stop();

 const few=await runtime(data);few.control.limit=5;await few.start();await few.tick(101);
 assert(!few.events.some(e=>e.worldMatrix),'5点以下で初期姿勢を採用しない');await few.stop();
 const expired=await runtime(data);await expired.start();await expired.tick(101);expired.control.empty=true;
 for(let i=2;i<=12;i++)await expired.tick(i*100+1);
 const resumed=expired.tracking.namespace.trackingStats.tries['直前の位置']||0;
 for(let i=1;i<=4;i++)await expired.tick(20000+i*100);
 assert.equal(expired.tracking.namespace.trackingStats.tries['直前の位置']||0,resumed,'期限後は古い姿勢で再開しない');await expired.stop();
 const stale=await runtime(data);let complete;stale.c._workerTrackUpdate=()=>new Promise(resolve=>complete=resolve);
 await stale.start();assert(complete);stale.c.stopProcessVideo();complete(stale.T);await flush();
 assert.equal(stale.events.length,0,'停止後に旧Workerの姿勢を反映しない');assert.equal(stale.disposedInputs(),1);await stale.stop();

 const builder=m.load(path.join(root,'js/trackpoints.js'));await builder.link(m.link);await builder.evaluate();
 const small=builder.namespace.makeZoomLevels(new Uint8Array(64*48).fill(255),64,48,{sizes:[32],targetWidth:128,targetHeight:96})[0];
 assert(Math.abs(small.scale-1/3)<1e-9,'別解像度の画像から作ってもmind座標に換算する');
 assert.throws(()=>builder.namespace.makeZoomLevels(new Uint8Array(64*48),64,48,{sizes:[32],targetWidth:100,targetHeight:100}));
 console.log('PASS: 局所選択・全体座標・点の分散・細かい段への移行・局所復帰・期限・停止後の結果・GPU再利用と解放・5点拒否・解像度換算');
})().catch(e=>{console.error(e);process.exitCode=1;});
