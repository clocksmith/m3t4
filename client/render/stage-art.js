// Render-only, fighter-scaled low-poly stage scenery. No simulation imports:
// platform rectangles are read verbatim, never expanded into collision geometry.
import { W, H } from './surface.js';

const PALETTES = {
  datacenter: { sky:'#0b1523', haze:'#284853', floor:'#142936', dark:'#0c1928', face:'#263d4a', side:'#152633', top:'#46606c', edge:'#83c5d0', light:'#66b6c2', accent:'#ba8850' },
  boardroom: { sky:'#19171e', haze:'#53463f', floor:'#29262b', dark:'#211e25', face:'#4d3a32', side:'#30282a', top:'#79604a', edge:'#bba080', light:'#c5a171', accent:'#648083' },
  demoday: { sky:'#141529', haze:'#3d365d', floor:'#24283f', dark:'#151a2b', face:'#36364e', side:'#202437', top:'#58516e', edge:'#bc9cdd', light:'#9d80ba', accent:'#4aabb6' },
};
const cache = new Map();
let motionQuery;

const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi,v));
const finite = (v,fallback=0) => Number.isFinite(v) ? v : fallback;

// Bounded framing, not an endlessly scrolling wallpaper. Replay seeks produce
// exactly the same scene. Reduced motion disables both drift and tracking.
export function stageSceneOffsets(frame, reducedMotion=false) {
  if (reducedMotion) return [0,0,0];
  const tick = Math.max(0, finite(frame?.tick));
  const center = (finite(frame?.p0?.x,W/2) + finite(frame?.p1?.x,W/2))/2;
  const look = clamp((center-W/2)/(W/2),-1,1);
  const drift = Math.sin((tick % 18000) * Math.PI * 2 / 18000);
  return [0, Math.round(-look*5+drift*2), Math.round(-look*11+drift*4)];
}

function prefersReducedMotion(override) {
  if (typeof override === 'boolean') return override;
  if (motionQuery === undefined && typeof window !== 'undefined') {
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  }
  return motionQuery?.matches ?? false;
}
function polygon(ctx,points,fill) {
  ctx.fillStyle=fill; ctx.beginPath(); ctx.moveTo(points[0][0],points[0][1]);
  for (let i=1;i<points.length;i++) ctx.lineTo(points[i][0],points[i][1]);
  ctx.closePath(); ctx.fill();
}
function line(ctx,points,color,width=1) {
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...points[0]);
  for(let i=1;i<points.length;i++)ctx.lineTo(...points[i]);ctx.stroke();
}
function rect(ctx,x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,h);}
function box(ctx,x,y,w,h,d,front,top,side) {
  polygon(ctx,[[x,y],[x+d,y-d*.55],[x+w+d,y-d*.55],[x+w,y]],top);
  polygon(ctx,[[x+w,y],[x+w+d,y-d*.55],[x+w+d,y+h-d*.55],[x+w,y+h]],side);
  rect(ctx,x,y,w,h,front);
}
function glow(ctx,x,y,r,color) {
  const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,color);g.addColorStop(1,'transparent');
  ctx.fillStyle=g;ctx.fillRect(x-r,y-r,r*2,r*2);
}
function arch(ctx,x,y,w,h,p) {
  const t=18;
  polygon(ctx,[[x,y+h],[x,y+45],[x+w*.20,y+8],[x+w*.5,y-6],[x+w*.80,y+8],[x+w,y+45],[x+w,y+h],[x+w-t,y+h],[x+w-t,y+52],[x+w*.75,y+27],[x+w*.5,y+14],[x+w*.25,y+27],[x+t,y+52],[x+t,y+h]],p.face);
  line(ctx,[[x+3,y+h],[x+3,y+45],[x+w*.2,y+11],[x+w*.5,y-3],[x+w*.8,y+11],[x+w-3,y+45]],p.top,3);
  line(ctx,[[x+w-t,y+h],[x+w-t,y+52],[x+w*.75,y+27]],p.side,5);
}
function rack(ctx,x,y,w,h,depth=10,dim=false) {
  box(ctx,x,y,w,h,depth,dim?'#233642':'#2c4250',dim?'#3a4c57':'#50616b','#132633');
  rect(ctx,x+5,y+5,w-10,h-10,'#122333');
  const unit=dim?14:18;
  for(let row=0;row<Math.floor((h-14)/unit);row++) {
    const yy=y+10+row*unit;
    rect(ctx,x+8,yy,w-16,unit-4,dim?'#293d48':'#314b59');
    rect(ctx,x+10,yy+2,w-25,2,'#405967');
    rect(ctx,x+w-13,yy+3,3,2,row%3?'#527f7f':'#9f946c');
  }
  line(ctx,[[x+3,y+3],[x+3,y+h-3]],'#516472');
}
function chair(ctx,x,y,scale=1) {
  ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
  polygon(ctx,[[-13,-40],[8,-43],[15,-35],[13,-16],[-10,-13],[-16,-20]],'#3d3840');
  polygon(ctx,[[-10,-37],[7,-39],[10,-33],[8,-19],[-8,-17]],'#655551');
  polygon(ctx,[[-15,-15],[11,-18],[20,-11],[-7,-6],[-18,-9]],'#736055');
  line(ctx,[[0,-7],[0,7],[-15,12],[0,7],[15,11]],'#25262d',3);
  line(ctx,[[-17,-22],[-20,-15],[-11,-13]],'#77716b',2);
  ctx.restore();
}
function truss(ctx,x,y,w,h,vertical=false) {
  rect(ctx,x,y,w,h,'#20283b');
  if(vertical){
    line(ctx,[[x+3,y],[x+3,y+h]],'#465064',3);line(ctx,[[x+w-3,y],[x+w-3,y+h]],'#39435a',3);
    for(let yy=y;yy<y+h-24;yy+=30)line(ctx,[[x+4,yy],[x+w-4,yy+27],[x+4,yy+27]],'#3b455a',2);
  }else{
    line(ctx,[[x,y+3],[x+w,y+3]],'#49536b',3);line(ctx,[[x,y+h-3],[x+w,y+h-3]],'#313c53',3);
    for(let xx=x;xx<x+w-30;xx+=42)line(ctx,[[xx,y+4],[xx+38,y+h-4],[xx+38,y+4]],'#3b455a',2);
  }
}

function atmosphere(ctx,id,p) {
  const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,p.sky);g.addColorStop(.60,p.haze);g.addColorStop(1,p.floor);
  ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  // Flat-shaded planes, perspective floor and broad light pools evoke early
  // console geometry rather than high-frequency pixels enlarged to screen size.
  polygon(ctx,[[0,0],[W,0],[1000,118],[280,118]],p.dark);
  polygon(ctx,[[0,0],[280,118],[280,515],[0,650]],p.sky);
  polygon(ctx,[[W,0],[1000,118],[1000,515],[W,650]],p.dark);
  polygon(ctx,[[0,650],[280,515],[1000,515],[W,650],[W,H],[0,H]],p.floor);
  for(const x of [-400,-160,80,320,560,800,1040,1280,1520]) line(ctx,[[640+(x-640)*.35,515],[x,H]],id==='boardroom'?'#3a3233':'#2a3947');
  for(const y of [540,578,632,710])line(ctx,[[0,y],[W,y]],id==='boardroom'?'#383033':'#253644');
  if(id==='datacenter') {
    for(let i=0;i<11;i++)rack(ctx,300+i*63,340,44,164,7,true);
    glow(ctx,640,305,340,'rgba(108,174,180,.13)');
    for(const x of [328,574,820]){
      box(ctx,x,137,100,8,15,'#48626c','#7f979c','#233a45');
      polygon(ctx,[[x+14,146],[x+93,146],[x+150,514],[x-58,514]],'rgba(126,192,196,.035)');
    }
  } else if(id==='boardroom') {
    for(let x=282;x<1000;x+=90){box(ctx,x,180,83,330,3,'#3b3030','#5b4940','#2c272c');rect(ctx,x+10,195,62,138,'#403531');rect(ctx,x+10,348,62,145,'#322b2c');}
    // A modest distant executive table and recognizably human-scale chairs.
    for(const x of [452,520,596,672,748,816])chair(ctx,x,518,.72);
    polygon(ctx,[[412,505],[805,505],[858,532],[380,532]],'#6b5141');
    polygon(ctx,[[380,532],[858,532],[858,541],[380,541]],'#3e302d');
    for(const x of [440,800])rect(ctx,x,541,8,35,'#28252b');
    for(const x of [395,640,885]){
      line(ctx,[[x,118],[x,206]],'#25232a',3);
      polygon(ctx,[[x-25,218],[x-15,202],[x+15,202],[x+25,218]],'#85715a');
      rect(ctx,x-18,219,36,3,'#c4aa79');glow(ctx,x,240,125,'rgba(195,154,95,.08)');
    }
  } else {
    // Abstract muted event screens, deliberately not target-ring purple/white.
    for(const [x,w] of [[310,170],[500,280],[800,170]]){
      box(ctx,x,210,w,170,6,'#25374a','#435163','#1b263b');
      polygon(ctx,[[x+6,216],[x+w-6,216],[x+w-6,373],[x+6,373]],'#344455');
      polygon(ctx,[[x+8,367],[x+w*.40,245],[x+w*.68,321],[x+w-8,259],[x+w-8,373]],'#3d5867');
      polygon(ctx,[[x+8,367],[x+w*.40,245],[x+w*.40,373]],'#4b6370');
      rect(ctx,x+18,230,Math.min(74,w*.45),4,'#657b85');
    }
    truss(ctx,268,176,744,20);truss(ctx,268,176,20,350,true);truss(ctx,992,176,20,350,true);
    // Distant audience stays behind the floor and far below combat contrast.
    for(let i=0;i<37;i++){
      const x=280+i*20,y=555+(i%3)*5;
      polygon(ctx,[[x-6,y],[x-5,y-10],[x-2,y-15],[x+3,y-15],[x+6,y-10],[x+6,y],[x+10,y+22],[x-10,y+22]],i%3?'#242b3e':'#303247');
    }
    glow(ctx,610,300,300,'rgba(129,102,171,.09)');
  }
  // Soft, static air layer pushes the far architecture away from combat.
  const fog=ctx.createLinearGradient(0,250,0,630);fog.addColorStop(0,'transparent');fog.addColorStop(.65,id==='boardroom'?'rgba(77,62,57,.20)':'rgba(48,67,83,.24)');fog.addColorStop(1,'transparent');ctx.fillStyle=fog;ctx.fillRect(0,200,W,440);
}

function middle(ctx,id,p) {
  if(id==='datacenter') {
    for(const x of [80,1060]){
      rack(ctx,x,446,65,150,15);
      rack(ctx,x+76,476,51,120,13);
      line(ctx,[[x+20,446],[x+20,405],[x+63,405],[x+85,438],[x+85,476]],'#3a5060',7);
      line(ctx,[[x+20,446],[x+20,405],[x+63,405]],'#60747b',2);
    }
    for(const x of [58,420,782,1144])arch(ctx,x,104,80,477,{face:'#253d4a',top:'#4d6570',side:'#162c3a'});
    for(const x of [112,474,836,1198]){
      rect(ctx,x,127,8,15,'#a5824d');glow(ctx,x+4,134,55,'rgba(199,139,64,.07)');
    }
    // Cable bundles retain the cold-aisle identity, now sparse and faceted.
    line(ctx,[[43,183],[167,226],[258,203],[350,225],[440,184]],'#343745',5);
    line(ctx,[[845,183],[954,220],[1043,203],[1123,224],[1250,180]],'#4b4244',4);
  } else if(id==='boardroom') {
    for(const x of [42,438,834])arch(ctx,x,104,362,486,{face:'#454146',top:'#666064',side:'#302e36'});
    for(const x of [62,424,820,1182]){
      box(ctx,x,278,28,300,10,'#49444a','#6a6265','#302e37');
      box(ctx,x-5,276,38,13,10,'#62595b','#7c6e69','#3a353d');
      box(ctx,x-7,573,42,18,8,'#48424a','#6d5e59','#302c35');
      line(ctx,[[x+7,304],[x+7,561]],'#585158',2);
    }
    for(const x of [145,231,1045,1128])chair(ctx,x,600,1);
    box(ctx,105,542,135,8,23,'#5d4638','#7c5e48','#3e3030');
    for(const x of [110,230])rect(ctx,x,550,7,48,'#2b252b');
    box(ctx,1040,550,97,8,18,'#594436','#785b47','#392d2e');
    // Small papers and desktop terminals establish a 56px human scale.
    polygon(ctx,[[143,537],[165,536],[172,541],[149,542]],'#8b8170');
    box(ctx,188,521,21,16,5,'#263b42','#58646a','#182b35');
    for(const [x,y] of [[92,611],[247,606],[1098,613]])polygon(ctx,[[x,y],[x+15,y-3],[x+22,y+3],[x+5,y+6]],'#756e64');
  } else {
    for(const x of [51,1199]){
      truss(ctx,x,99,30,504,true);
      box(ctx,x-14,465,45,124,12,'#292e43','#4c4e64','#1b2336');
      for(const y of [491,543]){
        polygon(ctx,[[x-5,y-15],[x+10,y-19],[x+23,y-9],[x+23,y+9],[x+10,y+18],[x-5,y+13],[x-10,y]],'#171e30');
        polygon(ctx,[[x,y-9],[x+12,y-10],[x+18,y],[x+12,y+11],[x,y+9],[x-4,y]],'#32384c');
      }
    }
    truss(ctx,50,99,1180,24);
    for(const x of [178,410,830,1062]){
      box(ctx,x,132,29,18,9,'#293249','#576075','#162237');
      polygon(ctx,[[x+3,150],[x+26,150],[x+142,560],[x-95,560]],x<640?'rgba(83,159,181,.055)':'rgba(165,119,188,.055)');
      rect(ctx,x+5,148,22,3,x<640?'#618e9d':'#88739a');
    }
    // Faceted hanging fabric, with geometry rather than pixel-noise folds.
    for(const x of [101,1090]){
      polygon(ctx,[[x,136],[x+88,136],[x+78,382],[x+60,367],[x+39,395],[x+19,376]],'#343749');
      polygon(ctx,[[x+8,140],[x+32,141],[x+39,395],[x+19,376]],'#44495b');
      polygon(ctx,[[x+58,140],[x+81,138],[x+78,382],[x+60,367]],'#252c42');
    }
  }
}
function near(ctx,id,p) {
  // Border framing never creates phantom terrain inside the playable arena.
  polygon(ctx,[[0,0],[35,0],[35,720],[0,720]],p.dark);
  polygon(ctx,[[W,0],[W-35,0],[W-35,720],[W,720]],p.dark);
  line(ctx,[[36,120],[36,637]],p.face,3);line(ctx,[[W-36,120],[W-36,637]],p.face,3);
  if(id==='datacenter')for(const x of [7,W-24]){
    rect(ctx,x,141,8,420,'#263340');rect(ctx,x+1,141,2,420,'#45535c');
  }
  const vignette=ctx.createLinearGradient(0,0,0,H);vignette.addColorStop(0,'rgba(2,5,13,.36)');vignette.addColorStop(.24,'transparent');vignette.addColorStop(.76,'transparent');vignette.addColorStop(1,'rgba(2,5,13,.25)');ctx.fillStyle=vignette;ctx.fillRect(0,0,W,H);
}
function makeLayers(id,p) {
  // At most three 1280×720 layers per launch stage (~32 MiB for all stages),
  // shared across renderer contexts. No per-frame gradients or prop loops.
  if (typeof document === 'undefined') return null;
  const layers=[];
  for(const draw of [atmosphere,middle,near]) {
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    const ctx=canvas.getContext?.('2d');if(!ctx)return null;
    draw(ctx,id,p);layers.push(canvas);
  }
  return layers;
}

export function drawStageScenery(ctx,stage,frame,options={}) {
  const id=Object.hasOwn(PALETTES,stage.id)?stage.id:'datacenter';
  const p=PALETTES[id];
  if(!cache.has(id))cache.set(id,makeLayers(id,p));
  const layers=cache.get(id),offsets=stageSceneOffsets(frame,prefersReducedMotion(options.reducedMotion));
  ctx.save();
  // Faceted scenery is anti-aliased; sprite rendering restores pixel sampling.
  ctx.imageSmoothingEnabled=true;
  const painters=[atmosphere,middle,near];
  for(let i=0;i<3;i++){
    ctx.save();ctx.translate(offsets[i],0);
    if(layers)ctx.drawImage(layers[i],0,0);else painters[i](ctx,id,p);
    ctx.restore();
  }
  for(const platform of stage.platforms)drawStagePlatform(ctx,platform,id);
  ctx.restore();
}

export function drawStagePlatform(ctx,p,id='datacenter') {
  const c=PALETTES[id]??PALETTES.datacenter;
  const {x,y,w,h}=p;
  // Every visible solid face is clipped to the exact sim rectangle. Only the
  // subdued cast shadow extends below it; the top highlight is the true y.
  ctx.save();rect(ctx,x+3,y+h,w,5,'rgba(0,0,0,.18)');
  ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
  rect(ctx,x,y,w,h,c.face);
  polygon(ctx,[[x,y],[x+w,y],[x+w-6,y+6],[x+5,y+6]],c.top);
  polygon(ctx,[[x+w-6,y+6],[x+w,y],[x+w,y+h],[x+w-6,y+h]],c.side);
  rect(ctx,x+2,y+7,3,Math.max(0,h-7),c.top);
  if(p.solid&&h>40&&w<90){
    if(id==='boardroom'){
      rect(ctx,x+9,y+15,w-19,h-26,c.side);
      line(ctx,[[x+12,y+18],[x+12,y+h-14]],'#6d5140',2);
      for(const yy of [y+10,y+h-12])rect(ctx,x,yy,w,5,c.top);
    }else if(id==='demoday'){
      for(let yy=y+28;yy<y+h-12;yy+=43){
        polygon(ctx,[[x+7,yy-10],[x+16,yy-14],[x+w-7,yy-9],[x+w-5,yy+7],[x+17,yy+13],[x+7,yy+7]],c.dark);
        polygon(ctx,[[x+12,yy-5],[x+20,yy-7],[x+26,yy],[x+20,yy+7],[x+12,yy+4]],c.top);
      }
    }else{
      for(let yy=y+16;yy<y+h-9;yy+=19){
        rect(ctx,x+7,yy,w-14,13,c.dark);rect(ctx,x+8,yy+2,w-21,2,c.top);rect(ctx,x+w-11,yy+5,3,2,c.light);
      }
    }
  }else{
    const spacing=p.solid?64:40;
    for(let xx=x+spacing;xx<x+w-4;xx+=spacing){line(ctx,[[xx,y+7],[xx,y+h]],c.side,2);rect(ctx,xx+4,y+8,2,2,c.top);}
    if(p.solid){
      rect(ctx,x+6,y+22,w-12,2,c.side);rect(ctx,x+6,y+h-13,w-12,4,c.dark);
      for(let xx=x+18;xx<x+w-12;xx+=38)polygon(ctx,[[xx,y+30],[xx+14,y+30],[xx+24,y+45],[xx+10,y+45]],c.side);
    }else{
      rect(ctx,x+5,y+h-4,w-10,2,c.dark);
    }
  }
  // Material cue remains understated, preserving purple/gold target priority.
  rect(ctx,x,y,w,2,c.edge);
  rect(ctx,x,y+h-2,w,2,c.dark);
  ctx.restore();
}
