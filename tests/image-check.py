"""CPU reproduction of MindAR's 13x13 NCC, ±10 search, threshold > .8.
Known planar camera views are generated from the user's drawing (not phone footage).
"""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from numpy.lib.stride_tricks import sliding_window_view

import argparse, subprocess, zipfile
PROJECT=Path(__file__).resolve().parents[1]
args=argparse.ArgumentParser()
args.add_argument('--baseline',help='比較する元のv15 ZIP（省略可）')
options=args.parse_args()
EXPORT=r"""
const fs=require('fs'),vm=require('vm'),path=require('path');
const ctx=vm.createContext({console,window:{},navigator:{userAgent:'Node'},URL,Blob,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,Uint8Array,ArrayBuffer});
const cache=new Map();const load=p=>{p=path.resolve(p);if(!cache.has(p))cache.set(p,new vm.SourceTextModule(fs.readFileSync(p,'utf8'),{context:ctx,identifier:p}));return cache.get(p);};
(async()=>{const m=load('lib/mindar/mindar-image.prod.js');await m.link((s,r)=>load(path.resolve(path.dirname(r.identifier),s)));await m.evaluate();
const d=new m.namespace.Compiler().importData(fs.readFileSync(0))[0];
process.stdout.write(JSON.stringify({targetImage:d.targetImage,trackingData:d.trackingData.map(f=>({...f,data:Array.from(f.data)}))}));
})().catch(e=>{console.error(e);process.exit(1)});
"""
def decode(blob):
    return json.loads(subprocess.check_output(['node','--experimental-vm-modules','--no-warnings','-e',EXPORT],input=blob,cwd=PROJECT))
new_data=decode((PROJECT/'data/all.mind').read_bytes())
old_data=None
if options.baseline:
    with zipfile.ZipFile(options.baseline) as z:
        old_data=decode(z.read('data/all.mind'))
source=Image.open(PROJECT/'data/image.jpg').convert('L')
original={'width':source.width,'height':source.height}
tw,th=new_data['targetImage']['width'],new_data['targetImage']['height']
W,H = 640,480
rng = np.random.default_rng(12)

def project(matrix, points):
    p = np.c_[points,np.ones(len(points))] @ matrix.T
    return p[:,:2]/p[:,2,None]

def camera(fraction,cx,cy,tilt=0):
    a=np.deg2rad(tilt); c,s=np.cos(a),np.sin(a)
    distance=600*tw*fraction/W
    pose=np.array([[1,0,-cx*tw],[0,c,-c*cy*th],[0,s,distance-s*cy*th]])
    actual=np.array([[600,0,W/2],[0,600,H/2],[0,0,1]])@pose
    inv=np.diag([original['width']/tw,original['height']/th,1])@np.linalg.inv(actual)
    inv/=inv[2,2]
    image=source.transform((W,H),Image.Transform.PERSPECTIVE,tuple(inv.ravel()[:8]),Image.Resampling.BICUBIC,fillcolor=255).filter(ImageFilter.GaussianBlur(.55))
    pixels=np.clip(np.array(image,dtype=float)+rng.normal(0,1.2,(H,W)),0,255)
    previous=np.array([[1,0,-3],[0,1,-2],[0,0,1]])@actual
    return actual,previous,pixels

def select(frame,mat):
    cells=[[] for _ in range(64)]
    for p in frame['points']:
        x,y=p['x']/frame['scale'],p['y']/frame['scale']; r=8/frame['scale']
        pts=project(mat,[[x,y],[x-r,y-r],[x+r,y-r],[x+r,y+r],[x-r,y+r]])
        if not np.all((pts[:,0]>=2)&(pts[:,0]<W-2)&(pts[:,1]>=2)&(pts[:,1]<H-2)): continue
        center=pts[0]; cells[int(center[1]/H*8)*8+int(center[0]/W*8)].append(p)
    selected=[]
    for rank in range(max(map(len,cells),default=0)):
        for cell in cells:
            if len(cell)>rank: selected.append(cell[rank])
            if len(selected)==64: return selected
    return selected

def match(frame,points,actual,previous,image):
    ref=np.array(frame['data'],dtype=float).reshape(frame['height'],frame['width'])
    scale=frame['scale']; y,x=np.indices(ref.shape)
    screen=project(previous,np.c_[x.ravel()/scale,y.ravel()/scale])
    ix,iy=np.floor(screen+.5).astype(int).T
    valid=(ix>=0)&(ix<W)&(iy>=0)&(iy<H)
    projected=np.zeros(len(ix)); projected[valid]=image[iy[valid],ix[valid]]
    projected=projected.reshape(ref.shape)
    padded=np.pad(projected,16)
    residuals=[]; matched=[]; world=[]
    for p in points:
        x,y=p['x'],p['y']
        template=ref[y-6:y+7,x-6:x+7]; template=template-template.mean()
        patches=sliding_window_view(padded[y:y+33,x:x+33],(13,13))
        centered=patches-patches.mean(axis=(-1,-2),keepdims=True)
        norm=np.sqrt((centered**2).sum(axis=(-1,-2))*(template**2).sum())
        scores=(centered*template).sum(axis=(-1,-2))/np.maximum(norm,1e-10)
        yy,xx=np.indices(scores.shape)
        scores[(x+xx-10<6)|(x+xx-10>=ref.shape[1]-6)|(y+yy-10<6)|(y+yy-10>=ref.shape[0]-6)]=-2
        index=np.unravel_index(scores.argmax(),scores.shape)
        if scores[index]<=.8: continue
        dy,dx=np.array(index)-10
        found=project(previous,[[(x+dx)/scale,(y+dy)/scale]])[0]
        expected=project(actual,[[x/scale,y/scale]])[0]
        residuals.append(float(np.linalg.norm(found-expected))); matched.append(found); world.append({"x":x/scale,"y":y/scale,"z":0})
    spread=False
    if len(matched)>=6:
        pts=np.array(matched)/[W,H]; cov=(pts-pts.mean(axis=0)).T@(pts-pts.mean(axis=0)); trace=np.trace(cov)
        spread=trace/len(pts)>.0004 and np.linalg.det(cov)>trace*trace*.003
    return {'worldCoords':world,'screenCoords':[{'x':float(q[0]),'y':float(q[1])} for q in matched],'errors':residuals,'candidates':len(points),'matches':len(matched),'correct_within_4px':sum(r<=4 for r in residuals),'median_error_px':round(float(np.median(residuals)),2) if residuals else None,'spread':bool(spread)}

cases=[('whole',1.1,.5,.5,0),('stone-quarter',.25,.37,.45,0),('stone-sixth',.16,.37,.45,0),('stone-tenth',.10,.37,.45,0),('stone-tenth-tilt',.10,.37,.45,35),('stone-twelfth',.08,.37,.45,0),('pots-sixth',.16,.78,.73,0),('pots-tenth',.1,.78,.73,0),('trench-lines',.2,.15,.55,0),('blank',.16,.8,.15,0)]
results=[]
for name,fraction,cx,cy,tilt in cases:
    actual,previous,image=camera(fraction,cx,cy,tilt)
    item={'view':name}
    for key,data,local in [('v15',old_data,False),('updated',new_data,True)]:
        if data is None: continue
        frames=[data['trackingData'][1]]+data['trackingData'][2:]
        px=W/(tw*fraction)
        pick=min(range(len(frames)),key=lambda i:abs(np.log(px/frames[i]['scale']/3)))
        attempts=[pick]+([pick+1,pick+2] if local else [])+([pick-1] if pick else [])
        records=[]
        for i in attempts:
            if i>=len(frames):continue
            f=frames[i];points=select(f,previous) if local and i>0 else f['points']
            r=match(f,points,actual,previous,image);r['level']=min(f['width'],f['height']);
            plane=np.linalg.inv(np.array([[600,0,W/2],[0,600,H/2],[0,0,1]]))@previous
            r['pose']=np.c_[plane[:,:2],np.zeros(3),plane[:,2]].tolist();records.append(r)
            if r['matches']>=6 and (r['spread'] or not local):break
        item[key]=records
    results.append(item)
records=[r for item in results for attempts in [item.get('v15',[]),item['updated']] for r in attempts]
filtered=json.loads(subprocess.check_output(['node','--experimental-vm-modules','--no-warnings','tests/filter-points.cjs'],input=json.dumps(records).encode(),cwd=PROJECT))
for record,kept in zip(records,filtered):
    errors={ (p['x'],p['y']):e for p,e in zip(record['worldCoords'],record['errors']) }
    record['used']=len(kept['worldCoords'])
    record['used_spread']=kept['spread']
    record['correct_used_within_4px']=sum(errors[(p['x'],p['y'])]<=4 for p in kept['worldCoords'])
    for key in ['worldCoords','screenCoords','errors','pose']: del record[key]
for result in results:
    print(json.dumps(result),flush=True)
    last=result['updated'][-1]
    if result['view'] in ['stone-quarter','stone-sixth','stone-tenth','stone-tenth-tilt','stone-twelfth','pots-sixth','pots-tenth']:
        assert last['used']>=6 and last['used_spread'], result
        assert last['correct_used_within_4px']==last['used'], result
    if result['view'] in ['trench-lines','blank']:
        assert last['matches']==0, result
print('PASS: 添付図面の合成映像による局所照合（スマホ実機ではない）')
