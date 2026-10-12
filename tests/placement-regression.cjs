// node --experimental-vm-modules --no-warnings tests/placement-regression.cjs
// 同梱のThree.js・GLTFLoader・実際の配置処理を使用。カメラ/GPUは不要。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({console, window:{}, navigator:{userAgent:"Node test"}, TextDecoder, TextEncoder, URL, Blob, performance, setTimeout, clearTimeout, ArrayBuffer, Uint8Array, Float32Array});
const cache = new Map();
function moduleFor(file) {
  if (cache.has(file)) return cache.get(file);
  const m = new vm.SourceTextModule(fs.readFileSync(path.join(root, file), 'utf8'), {context, identifier:file});
  cache.set(file, m);
  return m;
}
function link(spec, parent) {
  return moduleFor(spec === 'three' ? 'lib/three.module.min.js' : path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), spec.split('?')[0])));
}
function near(actual, expected, label) {
  for (let i=0;i<expected.length;i++) assert(Math.abs(actual[i]-expected[i]) < 1e-6, `${label}: ${actual} != ${expected}`);
}
const item = (axis='gltf-y-up', width=1, pixels=[1847,1238]) => ({id:'test',model:{coordinateSystem:axis},targetIndex:0,target:{realWidthM:width,realHeightM:width*pixels[1]/pixels[0]}});

// Blender頂点・ノードを標準GLBのY-up座標で記録した小さな実ファイルをメモリ内で構成する。
function makeGLB() {
  const positions = new Float32Array([.02,.03,-.01, .04,.03,-.01, .02,.05,-.03]);
  const json = {
    asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}],
    nodes:[
      {translation:[.25,.05,-.15],rotation:[0,Math.SQRT1_2,0,Math.SQRT1_2],scale:[2,4,3],children:[1]},
      {translation:[.1,.02,-.05],mesh:0},
    ],
    meshes:[{primitives:[{attributes:{POSITION:0}}]}],
    buffers:[{byteLength:positions.byteLength}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[.02,.03,-.03],max:[.04,.05,-.01]}],
  };
  let text = JSON.stringify(json);
  text += ' '.repeat((4-Buffer.byteLength(text)%4)%4);
  const bytes = Buffer.from(text), bin = Buffer.from(positions.buffer);
  const glb = Buffer.alloc(12+8+bytes.length+8+bin.length);
  glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(bytes.length,12); glb.writeUInt32LE(0x4e4f534a,16); bytes.copy(glb,20);
  glb.writeUInt32LE(bin.length,20+bytes.length); glb.writeUInt32LE(0x004e4942,24+bytes.length); bin.copy(glb,28+bytes.length);
  return glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength);
}

(async()=>{
  const m = moduleFor('js/placement.js'); await m.link(link); await m.evaluate();
  const T = cache.get('lib/three.module.min.js').namespace;
  const {createDrawingPlacement, createDrawingPlacements, prepareModelFrame, blenderBounds} = m.namespace;
  const toFile = (p, axis) => axis==='gltf-y-up' ? [p[0],p[2],-p[1]] : p;
  for (const pixels of [[1847,1238],[800,1200]]) for (const width of [1,20]) for (const axis of ['gltf-y-up','blender-z-up']) {
    const info=createDrawingPlacement(item(axis,width,pixels),pixels);
    info.group.updateMatrixWorld(true);
    const h=width*pixels[1]/pixels[0], aspect=pixels[1]/pixels[0];
    for (const [point, expected] of [
      [[0,0,0],[-.5,-aspect/2,0]],
      [[width,0,0],[.5,-aspect/2,0]],
      [[0,h,0],[-.5,aspect/2,0]],
      [[width,h,0],[.5,aspect/2,0]],
      [[width*.25,h*.75,width*.2],[-.25,aspect*.25,.2]],
      [[-width*.1,-h*.1,-width*.1],[-.6,-aspect*.6,-.1]],
    ]) near(new T.Vector3(...toFile(point,axis)).applyMatrix4(info.group.matrixWorld).toArray(),expected,'四隅・高さ・符号');
  }

  const loader = moduleFor('lib/three-addons/loaders/GLTFLoader.js'); await loader.link(link); await loader.evaluate();
  const gltf=await new loader.namespace.GLTFLoader().parseAsync(makeGLB(),'');
  const config=item(); config.model.rotationDeg=[17,31,59]; // 旧補正値をARで二重適用しない
  const model=prepareModelFrame(gltf.scene,config,{preservePlacement:true});
  const placement=createDrawingPlacement(config,[1847,1238]);
  placement.group.add(model.unit); placement.group.updateMatrixWorld(true);
  let mesh; gltf.scene.traverse(o=>{if(o.isMesh)mesh=o;});
  const vertex=new T.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,0);
  near(vertex.clone().applyMatrix4(mesh.matrixWorld).toArray(),[.07-.5,.39-1238/1847/2,.25],'GLB読込：親子の位置・回転・非等方スケールを保存');

  // アノテーションはGLBシーン座標でモデルと同じ親に置くと、同じ位置へ変換される。
  const note=new T.Object3D(); note.position.set(.07,.25,-.39); model.raw.add(note);
  placement.group.updateMatrixWorld(true);
  near(note.getWorldPosition(new T.Vector3()).toArray(),vertex.clone().applyMatrix4(mesh.matrixWorld).toArray(),'モデルと注釈の座標共有');

  // 外寸の違うモデルでも、同じ元座標の位置が変わらない。中心・底面への移動は行わない。
  for (const size of [.1,100]) {
    const scene=new T.Group(); const shape=new T.Mesh(new T.BoxGeometry(size,size,size)); shape.position.set(-2,3,-4); scene.add(shape);
    const prepared=prepareModelFrame(scene,item(),{preservePlacement:true});
    prepared.unit.updateMatrixWorld(true);
    near(new T.Vector3(.25,.2,-.1).applyMatrix4(prepared.raw.matrixWorld).toArray(),[.25,.2,-.1],'外寸に依存しない');
  }
  const b=blenderBounds(model,'gltf-y-up');
  assert(b.min.x>=0&&b.min.y>=0&&b.min.z>=0,'正のBlender領域の診断');
  const viewerScene=new T.Group(); viewerScene.add(new T.Mesh(new T.BoxGeometry(2,4,6)));
  const viewer=prepareModelFrame(viewerScene,item('blender-z-up'));
  viewer.unit.updateMatrixWorld(true);
  const vb=new T.Box3().setFromObject(viewer.unit), vs=vb.getSize(new T.Vector3());
  near([vb.min.y,Math.max(vs.x,vs.y,vs.z)],[0,1],'通常ビューの自動フィットは維持');
  // 利用者の例：全体40m×30m、点(10,15,2)は左から25%、下から50%、高さ2m相当。
  const metric=item('blender-z-up',40,[4000,3000]);
  const mapped=createDrawingPlacement(metric,[4000,3000]); mapped.group.updateMatrixWorld(true);
  near(new T.Vector3(10,15,2).applyMatrix4(mapped.group.matrixWorld).toArray(),[-.25,0,.05],'実寸から画像内位置への対応');
  assert.equal(mapped.width,40); assert.equal(mapped.height,30);
  // 古い幅を残しても、新しい縦横の値を使う。
  metric.target.blenderWidth=999;
  near(createDrawingPlacement(metric,[4000,3000]).group.scale.toArray(),[.025,.025,.025],'実寸値を使用');
  // 数値の丸めは許容するが形状は変えない。高さの違いが1%を超える場合は明確に失敗する。
  metric.target.realHeightM=30.15;
  const rounded=createDrawingPlacement(metric,[4000,3000]);
  near(rounded.group.scale.toArray(),[.025,.025,.025],'縦横別に拡縮しない');
  assert(rounded.aspectError > .004 && rounded.aspectError < .006);
  metric.target.realHeightM=30.6;
  assert.throws(()=>createDrawingPlacement(metric,[4000,3000]),/縦横比/);
  metric.target.realHeightM=29.4;
  assert.throws(()=>createDrawingPlacement(metric,[4000,3000]),/縦横比/);
  for(const field of ['realWidthM','realHeightM']) for(const bad of [0,-1,NaN,Infinity,'1',null,undefined]) {
    const cfg=item(); cfg.target[field]=bad;
    assert.throws(()=>createDrawingPlacement(cfg,[1847,1238]),new RegExp(field));
  }
  const legacy=item(); delete legacy.target.realWidthM; delete legacy.target.realHeightM; legacy.target.blenderWidth=1;
  assert.throws(()=>createDrawingPlacement(legacy,[1847,1238]),/realWidthM/,'旧設定だけでは仮寸法を使わない');
  assert.throws(()=>createDrawingPlacement(item('unknown'),[1847,1238]));
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/items.json'),'utf8'));
  // 同梱Compilerで実際のall.mindを読み、台帳に画素数がないまま配置できることを確認。
  const targetsModule=moduleFor('js/drawing-targets.js'); await targetsModule.link(link); await targetsModule.evaluate();
  const {loadDrawingTargets}=targetsModule.namespace;
  const actualBytes=fs.readFileSync(path.join(root,'targets/all.mind'));
  let requested;
  context.fetch=async (src,options)=>{requested={src,options};return new Response(actualBytes);};
  const actual=await loadDrawingTargets('targets/all.mind');
  assert.equal(requested.options.cache,'no-cache');
  assert.deepEqual(Array.from(actual.dimensions[0]),[1847,1238]);
  assert(Buffer.from(actual.buffer).equals(actualBytes),'追跡へ渡す認識データを改変しない');
  createDrawingPlacements(catalog.items,actual.dimensions);
  // MindARはこのURLをfetchする。探し直しでも同じデータを複数回読める。
  const blobUrl=URL.createObjectURL(new Blob([actual.buffer]));
  try { for(let i=0;i<2;i++) assert(Buffer.from(await (await fetch(blobUrl)).arrayBuffer()).equals(actualBytes)); }
  finally { URL.revokeObjectURL(blobUrl); }

  // 画像差し替え：旧1847×1238の入力を残しても、新しい縦長1920×2150だけを使う。
  const portrait=item('blender-z-up',19.2,[1920,2150]);
  portrait.target.realHeightM=21.5;
  portrait.target.widthPx=1847; portrait.target.heightPx=1238;
  const Compiler=cache.get('lib/mindar/mindar-image.prod.js').namespace.Compiler;
  const compiler=new Compiler();
  compiler.data=[{targetImage:{width:1920,height:2150},matchingData:[],trackingData:[]}];
  const portraitBytes=compiler.exportData();
  context.fetch=async()=>new Response(portraitBytes);
  const replacement=await loadDrawingTargets('targets/all.mind');
  const [fresh]=createDrawingPlacements([portrait],replacement.dimensions);
  fresh.group.updateMatrixWorld(true);
  assert.equal(fresh.widthPx,1920); assert.equal(fresh.heightPx,2150);
  near(new T.Vector3(19.2,21.5,0).applyMatrix4(fresh.group.matrixWorld).toArray(),[.5,2150/1920/2,0],'差し替え後の右上');
  portrait.target.widthPx=null; portrait.target.heightPx='obsolete';
  createDrawingPlacements([portrait],replacement.dimensions);
  delete portrait.target.widthPx; delete portrait.target.heightPx;
  createDrawingPlacements([portrait],replacement.dimensions);

  // 配列の順でなくtargetIndexで対応を取る（縦長と横長の複数図面）。
  const landscape=item('blender-z-up',40,[4000,3000]); landscape.targetIndex=1;
  const multi=createDrawingPlacements([landscape,portrait],[[1920,2150],[4000,3000]]);
  assert.equal(multi[0].widthPx,4000); assert.equal(multi[1].heightPx,2150);
  assert.throws(()=>createDrawingPlacements([portrait,portrait],replacement.dimensions),/targetIndex/);
  for(const index of [-1,1.5,2,'0',undefined]) {
    assert.throws(()=>createDrawingPlacements([{...portrait,targetIndex:index}],replacement.dimensions),/targetIndex/);
  }
  assert.throws(()=>createDrawingPlacement(portrait),/all.mind/,'画素数の旧入力へ戻らない');

  context.fetch=async()=>new Response('missing',{status:404});
  await assert.rejects(loadDrawingTargets('targets/all.mind'),/HTTP 404/);
  context.fetch=async()=>{throw new Error('offline');};
  await assert.rejects(loadDrawingTargets('targets/all.mind'),/通信状態/);
  context.fetch=async()=>new Response('<html>not mind</html>');
  await assert.rejects(loadDrawingTargets('targets/all.mind'),/無効/);
  for(const targetImage of [{width:0,height:1},{width:1,height:-1},{width:'1920',height:2150},{width:1.5,height:2},{}]) {
    compiler.data=[{targetImage,matchingData:[],trackingData:[]}];
    context.fetch=async()=>new Response(compiler.exportData());
    await assert.rejects(loadDrawingTargets('targets/all.mind'),/無効/);
  }
  compiler.data=[];
  context.fetch=async()=>new Response(compiler.exportData());
  await assert.rejects(loadDrawingTargets('targets/all.mind'),/無効/);
  console.log('PASS: 実際のall.mind読込、解像度未入力・旧値の無視、縦長画像への差し替え、複数図面の対応、HTTP/破損エラー、同一データ再利用');
  console.log('PASS: 実寸の縦横、必須入力、縦横比検証、形状保持、図面四隅、正負XYZ、GLB読込、親子変換、外寸非依存、注釈座標、通常ビュー');
})().catch(err=>{console.error(err);process.exitCode=1;});
