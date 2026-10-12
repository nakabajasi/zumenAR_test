// node --experimental-vm-modules --no-warnings tests/drawing-startup-regression.cjs
// AR本体・配置・認識データの読込は実コード。カメラ/GPU/DOMだけを代替する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const config = {items:[{id:'item01',targetIndex:0,model:{coordinateSystem:'blender-z-up'},
  target:{widthPx:1847,heightPx:1238,realWidthM:19.2,realHeightM:1}}]};
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {hidden:false,events:{},addEventListener(name,fn){this.events[name]=fn;},remove(){},setAttribute(){}});
  return elements.get(id);
}
let targetBytes, cameraFailure = false, constructions = 0, cameras = 0, networkReads = 0, stopped = 0;
const context = vm.createContext({
  console:{...console,error(){}}, TextDecoder, TextEncoder, URL, URLSearchParams, Blob, ArrayBuffer, Uint8Array,
  performance, setTimeout, clearTimeout,
  window:{isSecureContext:true,devicePixelRatio:1,addEventListener(){}},
  navigator:{userAgent:'Node test',mediaDevices:{getUserMedia(){}}},
  location:{search:''},screen:{orientation:{addEventListener(){}}},
  document:{getElementById:element,addEventListener(){},body:{append(){}}},
  fetch:async(src,options)=>{
    if (String(src).startsWith('blob:')) return fetch(src,options);
    networkReads++;
    assert.equal(options.cache,'no-cache');
    return new Response(targetBytes);
  },
});
const cache = new Map();
function moduleFor(file) {
  if (!cache.has(file)) cache.set(file,new vm.SourceTextModule(fs.readFileSync(path.join(root,file),'utf8'),{context,identifier:file}));
  return cache.get(file);
}
function link(spec,parent) {
  return moduleFor(spec==='three'?'lib/three.module.min.js':path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),spec.split('?')[0])));
}
function stub(exports) {
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context});
}
(async()=>{
  const three=moduleFor('lib/three.module.min.js');await three.link(link);await three.evaluate();
  const T=three.namespace;
  const compilerModule=moduleFor('lib/mindar/mindar-image.prod.js');await compilerModule.link(link);await compilerModule.evaluate();
  const Compiler=compilerModule.namespace.Compiler;
  const compiler=new Compiler();
  compiler.data=[{targetImage:{width:1920,height:2150},matchingData:[],trackingData:[]}];
  const portraitBytes=compiler.exportData();
  targetBytes=portraitBytes;
  class MindARThree {
    constructor(options) {
      constructions++;
      this.imageTargetSrc=options.imageTargetSrc;this.scene=new T.Scene();this.camera=new T.PerspectiveCamera();
      this.renderer={domElement:{addEventListener(){}},setPixelRatio(){},setAnimationLoop(){},render(){},dispose(){}};
    }
    addAnchor(){return {group:new T.Group(),visible:false};}
    async start(){
      cameras++;
      this.video={srcObject:{getTracks:()=>[{stop(){stopped++;}}]},remove(){}};
      if(cameraFailure)throw new Error('camera denied');
      this.bytes=await (await fetch(this.imageTargetSrc)).arrayBuffer();
      this.controller={stopProcessVideo(){},worker:{terminate(){}},markerDimensions:new Compiler().importData(this.bytes).map(d=>[d.targetImage.width,d.targetImage.height])};
    }
    stop(){this.video.srcObject.getTracks().forEach(t=>t.stop());}
  }
  const mocks={
    'tracking.js':stub({TRACKING_DEFAULTS:{},trackingStats:{},installTracking(){}}),
    'mindar-image-three.prod.js':stub({MindARThree}),
    'panel.js':stub({createPanel:()=>({})}),
    'common.js':stub({url:p=>p,loadCatalog:async()=>config,itemFromQuery:()=>null,isInAppBrowser:()=>false,
      fetchJson(){},loadItemObject(){},addLights(){},buildAnnotations(){},pickAnnotation(){},syncLineResolution(){}}),
  };
  const ar=moduleFor('js/ar.js');
  await ar.link((spec,parent)=>mocks[spec.split('?')[0].split('/').pop()]||link(spec,parent));await ar.evaluate();await flush();
  const press=()=>element('btn-start').events.click();

  // 実寸不一致はカメラ/GPUを作る前に説明でき、修正後に再試行できる。
  await press();
  assert.match(element('gate-error').textContent,/1920×2150px/);
  assert.equal(constructions,0);assert.equal(cameras,0);
  targetBytes='<html>404 page</html>';
  await press();
  assert.match(element('gate-error').textContent,/認識データ all.mind が無効/);
  assert.equal(constructions,0);

  // カメラ拒否からの再試行。失敗時のデータURLとカメラを解放する。
  targetBytes=portraitBytes;config.items[0].target.realHeightM=21.5;cameraFailure=true;
  await press();
  assert.match(element('gate-error').textContent,/カメラを起動できません/);
  assert.equal(stopped,1);assert.equal(context.window.__ar.mindar,null);
  cameraFailure=false;
  await press();
  const state=context.window.__ar;
  assert.equal(element('gate').hidden,true);
  assert.equal(state.slots[0].placement.widthPx,1920);
  assert.equal(state.slots[0].placement.heightPx,2150);
  assert(Math.abs(state.slots[0].place.position.y+2150/1920/2)<1e-9);
  assert(Buffer.from(state.mindar.bytes).equals(Buffer.from(portraitBytes)));

  // 起動中に公開データが変わっても、探し直しだけでは認識と配置の基準が食い違わない。
  targetBytes=fs.readFileSync(path.join(root,'targets/all.mind'));
  const readsBefore=networkReads;
  await state.restart();
  assert.equal(networkReads,readsBefore);
  assert(Buffer.from(state.mindar.bytes).equals(Buffer.from(portraitBytes)));
  assert.equal(state.slots[0].placement.heightPx,2150);
  URL.revokeObjectURL(state.mindar.imageTargetSrc);
  console.log('PASS: AR起動順序、実寸不一致・破損データの起動前エラー、カメラ拒否後の再試行、旧解像度無視、探し直し時の認識と配置の一致');
})().catch(err=>{console.error(err);process.exitCode=1;});
