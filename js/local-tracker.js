// 同梱MindAR 1.2.5用。元図面の座標を保ち、いま見える点だけをGPUへ送る。
export const LOCAL_LIMIT = 64;

function project(K, T, x, y) {
  const a=T[0][0]*x+T[0][1]*y+T[0][3], b=T[1][0]*x+T[1][1]*y+T[1][3], c=T[2][0]*x+T[2][1]*y+T[2][3];
  if (!(c>1e-6)) return null;
  const z=K[2][0]*a+K[2][1]*b+K[2][2]*c;
  return {x:(K[0][0]*a+K[0][1]*b+K[0][2]*c)/z,y:(K[1][0]*a+K[1][1]*b+K[1][2]*c)/z};
}

export function selectVisible(frame, K, T, width, height) {
  const cells=Array.from({length:64},()=>[]);
  const inside=p=>p&&p.x>=2&&p.y>=2&&p.x<width-2&&p.y<height-2;
  const radius=8/frame.scale; // 照合窓の半径6＋余裕2。探索の端は結果側でも画面内か確かめる。
  let visible=0;
  for (const p of frame.points) {
    const x=p.x/frame.scale,y=p.y/frame.scale,q=project(K,T,x,y);
    if (!inside(q)) continue;
    if (![[x-radius,y-radius],[x+radius,y-radius],[x+radius,y+radius],[x-radius,y+radius]]
      .every(([u,v])=>inside(project(K,T,u,v)))) continue;
    visible++;
    cells[Math.floor(q.y/height*8)*8+Math.floor(q.x/width*8)].push(p);
  }
  const points=[];
  for (let rank=0;points.length<LOCAL_LIMIT;rank++) {
    let added=false;
    for (const cell of cells) {
      if (cell[rank]) {points.push(cell[rank]);added=true;}
      if (points.length===LOCAL_LIMIT) break;
    }
    if (!added) break;
  }
  return {points,visible};
}

export function hasSpread(points,width,height) {
  if (points.length<6||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) return false;
  const mx=points.reduce((a,p)=>a+p.x,0)/points.length,my=points.reduce((a,p)=>a+p.y,0)/points.length;
  let xx=0,xy=0,yy=0;
  for (const p of points) {const x=(p.x-mx)/width,y=(p.y-my)/height;xx+=x*x;xy+=x*y;yy+=y*y;}
  const trace=xx+yy;
  return trace/points.length>0.0004&&xx*yy-xy*xy>trace*trace*0.003;
}

export class LocalTracker {
  constructor(Tracker, dims, frame, K, width, height, tf) {
    this.frame=frame;this.K=K;this.width=width;this.height=height;this.tf=tf;
    // NativeのGPUカーネルは初回の点数を保持する。部分ごとに変えず、常に64枠にする。
    const seed={...frame,points:Array.from({length:LOCAL_LIMIT},(_,i)=>frame.points[i%frame.points.length])};
    this.native=new Tracker([dims],[[seed,seed]],K,width,height);
  }
  dummyRun(input) {this.native.dummyRun(input);}
  track(input,T) {
    const frame=this.frame,selected=selectVisible(frame,this.K,T,this.width,this.height);
    const info={candidates:selected.points.length,visible:selected.visible,registered:frame.points.length};
    if (selected.points.length<6) return {worldCoords:[],screenCoords:[],...info};
    const coordinates=new Float32Array(LOCAL_LIMIT*2).fill(-1);
    selected.points.forEach((p,i)=>{coordinates[2*i]=p.x/frame.scale;coordinates[2*i+1]=p.y/frame.scale;});
    const features=this.tf.tensor(coordinates,[LOCAL_LIMIT,2],'float32');
    this.native.featurePointsListT[0].dispose();this.native.featurePointsListT[0]=features;
    this.native.trackingKeyframeList[0]={...frame,points:selected.points};
    const result=this.native.track(input,T,0),worldCoords=[],screenCoords=[];
    result.screenCoords.forEach((p,i)=>{
      if (p.x>=2&&p.y>=2&&p.x<this.width-2&&p.y<this.height-2) {worldCoords.push(result.worldCoords[i]);screenCoords.push(p);}
    });
    return {worldCoords,screenCoords,...info};
  }
  dispose() {
    if (!this.native) return;
    this.tf.dispose([this.native.featurePointsListT,this.native.imagePixelsListT,this.native.imagePropertiesListT]);
    this.native=null;
  }
}
