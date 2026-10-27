// image-check.pyから利用。模擬映像の対応点を実際の誤対応除外に通す。
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..'),context=vm.createContext({console,window:{},navigator:{}}),cache=new Map();
const load=p=>{p=path.resolve(p.split('?')[0]);if(!cache.has(p))cache.set(p,new vm.SourceTextModule(fs.readFileSync(p,'utf8'),{context,identifier:p}));return cache.get(p);};
const stub=new vm.SyntheticModule(['Controller'],function(){this.setExport('Controller',class{});},{context});
(async()=>{
 const m=load(path.join(root,'js/tracking.js'));
 await m.link((s,r)=>s.includes('mindar-image.prod')?stub:load(path.resolve(path.dirname(r.identifier),s)));await m.evaluate();
 const K=[[600,0,320],[0,600,240],[0,0,1]];
 const records=JSON.parse(fs.readFileSync(0,'utf8'));
 const {hasSpread}=load(path.join(root,'js/local-tracker.js')).namespace;
 process.stdout.write(JSON.stringify(records.map(r=>{
   const used=m.namespace.consistentPoints(K,r.pose,r.worldCoords,r.screenCoords);
   return {...used,spread:hasSpread(used.screenCoords,640,480)};
 })));
})().catch(e=>{console.error(e);process.exitCode=1;});
