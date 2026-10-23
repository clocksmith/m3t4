import{chromium}from'playwright';
import{createDevServer}from'./dev-serve.mjs';
import{mkdir,writeFile}from'node:fs/promises';
import path from'node:path';
const output=path.resolve(process.argv[2]||'test-results/roster-appearance');await mkdir(output,{recursive:true});
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:1});
 await page.goto(origin+'/');
 const styles=await page.locator('.roster-avatar').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return{image:s.backgroundImage,size:s.backgroundSize,position:s.backgroundPosition};}));
 await page.setContent(`<base href="${origin}/"><style>body{margin:20px;background:#192234;color:white;font:16px monospace}main{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}section{text-align:center;background:#273146;padding:12px} .portrait{width:96px;height:96px;margin:12px auto;background-repeat:no-repeat;image-rendering:pixelated;border:1px solid #445}canvas{width:160px;height:160px;image-rendering:pixelated}h1{font-size:24px}p{font-size:12px}</style><h1>All six fighters at equal rendered scale</h1><p>Portrait: 96×96 CSS pixels, actual home-page crop. Body: common 56px standing scale, shown 2×. Both facings.</p><main></main>`);
 const report=await page.evaluate(async({origin,styles})=>{
  const {drawFrame}=await import(origin+'/render/canvas2d.js'),{STAGES}=await import(origin+'/lib/public-sim.js');
  const {portraitBackgroundStyle}=await import(origin+'/content/character-presentation.js');
  const catalog=await(await fetch(origin+'/content/roster-catalog.v1.json')).json(),metrics=[];
  for(const [i,body] of catalog.bodies.entries()){
   const section=document.createElement('section'),s=styles[i];section.innerHTML=`<h2>${body}</h2><div class="portrait" style='background-image:${s.image};background-size:${s.size};background-position:${s.position}'></div>`;document.querySelector('main').append(section);
   const expected=document.createElement('div');expected.style.cssText=portraitBackgroundStyle(body,0);
   for(const [actual,wanted] of [[s.size,expected.style.backgroundSize],[s.position,expected.style.backgroundPosition]]){
    const a=actual.match(/[\d.]+/g).map(Number),b=wanted.match(/[\d.]+/g).map(Number);
    if(a.some((v,n)=>Math.abs(v-b[n])>.0001))throw Error(`Home/Canvas portrait framing differs: ${body}`);
   }
   const portraitUrl=s.image.slice(5,-2);await new Promise((resolve,reject)=>{const img=new Image();img.onload=resolve;img.onerror=reject;img.src=portraitUrl;});
   const canvas=document.createElement('canvas');canvas.width=80;canvas.height=80;section.append(canvas);
   const mirror=document.createElement('canvas');mirror.width=80;mirror.height=80;section.append(mirror);
   const off=document.createElement('canvas');off.width=1280;off.height=720;const oc=off.getContext('2d'),native=oc.drawImage.bind(oc);let rigs=0;
   oc.drawImage=(img,...args)=>{if(img.src?.split('?')[0].endsWith(`/rig-v1/${body}.png`))rigs++;native(img,...args);};
   const weapon=catalog.weapons[body][0].id,f={body,weapon,weaponMotionVersion:1,x:450,y:420,vx:0,vy:0,onGround:true,wall:0,facing:1,stun:0,swipeT:0,diveT:0,lastClashTick:-9999,dead:false};
   const frame={tick:500,roundStartTick:0,p0:f,p1:{...f,x:850,facing:-1},token:{exists:false,carrier:-1},goal:{exists:false},scoreboard:[0,0],rounds:[0,0]};
   for(let n=0;n<100;n++){rigs=0;drawFrame(oc,STAGES.datacenter,frame,{});if(rigs>=20)break;await new Promise(r=>setTimeout(r,20));}
   if(rigs<20)throw Error('Rig unavailable: '+body);
   canvas.getContext('2d').drawImage(off,410,375,80,80,0,0,80,80);mirror.getContext('2d').drawImage(off,810,375,80,80,0,0,80,80);
   metrics.push({body,portraitPixels:[96,96],standingBodyHeight:56,styles:s});
  }
  return metrics;
 },{origin,styles});
 await page.screenshot({path:path.join(output,'six-fighters.png'),fullPage:true});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 for(const width of[1440,390]){await page.setViewportSize({width,height:1000});await page.goto(origin+'/');await page.locator('.roster-avatar').first().waitFor();await page.locator('.roster-grid').screenshot({path:path.join(output,`home-roster-${width}.png`)});}
 console.log(output);
}finally{await browser.close();await new Promise(r=>server.close(r));}
