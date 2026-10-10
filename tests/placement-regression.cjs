// node --experimental-vm-modules --no-warnings tests/placement-regression.cjs
// 同梱のThree.js・GLTFLoader・実際の配置処理を使用。カメラ/GPUは不要。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({console, TextDecoder, TextEncoder, URL, ArrayBuffer, Uint8Array, Float32Array});
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
const item = (axis='gltf-y-up', width=1, pixels=[1847,1238]) => ({id:'test',model:{coordinateSystem:axis},target:{widthPx:pixels[0],heightPx:pixels[1],blenderWidth:width}});

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
  const {createDrawingPlacement, prepareModelFrame, blenderBounds} = m.namespace;
  const toFile = (p, axis) => axis==='gltf-y-up' ? [p[0],p[2],-p[1]] : p;
  for (const pixels of [[1847,1238],[800,1200]]) for (const width of [1,20]) for (const axis of ['gltf-y-up','blender-z-up']) {
    const info=createDrawingPlacement(item(axis,width,pixels));
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
  const placement=createDrawingPlacement(config);
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
  for(const bad of [0,-1,NaN,Infinity,'1',null]) {
    const cfg=item(); cfg.target.widthPx=bad; assert.throws(()=>createDrawingPlacement(cfg));
    cfg.target.widthPx=1847; cfg.target.blenderWidth=bad;
    if(bad!==null)assert.throws(()=>createDrawingPlacement(cfg));
  }
  assert.throws(()=>createDrawingPlacement(item('unknown')));
  console.log('PASS: 横長/縦長、任意幅、図面四隅、正負XYZ、標準GLB読込、親子変換、外寸非依存、注釈座標、通常ビュー、入力検証');
})().catch(err=>{console.error(err);process.exitCode=1;});
