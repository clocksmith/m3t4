// Local browser evidence: real renderer, all bodies/weapons, no cloud services.
import { chromium } from 'playwright';
import { createDevServer } from './dev-serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve(process.argv[2] || 'test-results/roster-art');
const legacy=process.argv.includes('--legacy');
await mkdir(output, {recursive:true});
const server = createDevServer();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const errors=[];
try {
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
    await page.goto(origin+'/render/fighter-art.js');
    await page.setContent(`<base href="${origin}/"><style>body{margin:16px;background:#171d2b;color:#eef;font:14px monospace}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}section{background:#252d3f;padding:8px}canvas{width:100%;image-rendering:pixelated}h2{font-size:14px}p{margin:8px 0}</style><h1>Duel roster and weapon motion review</h1><main></main>`);
    const rows=await page.evaluate(async({origin,legacy})=>{
      const {drawFrame}=await import(origin+'/render/canvas2d.js');
      const {STAGES,STATS}=await import(origin+'/lib/public-sim.js');
      const kinematics=legacy?{attackDuration:()=>STATS.swipeTime}:await import(origin+'/sim/weapon-kinematics.js');
      const catalog=await (await fetch(origin+'/content/roster-catalog.v1.json')).json();
      const skins=['monastic_infra','legal_department_midnight','chalk_and_static','wellness_berserker','silicon_sovereign','orbital_showman'];
      const urls=catalog.bodies.flatMap((body,i)=>[`assets/chars/${body}/${skins[i]}/sprite.png`,`assets/chars/${body}/${skins[i]}/portraits/sheet.png`,`assets/weapons/${body}/sheet.png`]);
      if(!legacy)urls.push(...catalog.bodies.map(body=>`assets/chars/rig-v1/${body}.png`));
      await Promise.all(urls.map(url=>new Promise((resolve,reject)=>{const im=new Image();im.onload=resolve;im.onerror=()=>reject(Error(url));im.src=origin+'/'+url;})));
      const rows=[];
      for(const [i,body] of catalog.bodies.entries()){
        const section=document.createElement('section');section.innerHTML=`<h2>${body}</h2>`;
        const idle=document.createElement('canvas');idle.width=192;idle.height=80;section.append(idle);
        document.querySelector('main').append(section);
        for(const weapon of catalog.weapons[body]){
          const label=document.createElement('p');label.textContent=weapon.id;section.append(label);
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=300;section.append(canvas);const ctx=canvas.getContext('2d');
          for(const [n,progress] of [0,.18,.5,.82,1].entries()){
            const off=document.createElement('canvas');off.width=1280;off.height=720;const oc=off.getContext('2d');
            const nativeDraw=oc.drawImage.bind(oc);let rigDraws=0,weaponDraws=0;
            oc.drawImage=(image,...args)=>{if(image.src?.split('?')[0].endsWith(`/rig-v1/${body}.png`))rigDraws++;if(image.src?.includes('/weapons/'))weaponDraws++;nativeDraw(image,...args);};
            const f={body,weapon:weapon.id,weaponMotionVersion:legacy?undefined:1,x:450,y:420,vx:0,vy:0,onGround:true,wall:0,facing:1,stun:0,swipeT:progress===0?0:kinematics.attackDuration({weapon:weapon.id,weaponMotionVersion:1})*(1-progress)+.00001,diveT:0,lastClashTick:-9999,dead:false};
            const frame={tick:500,roundStartTick:0,p0:f,p1:{...f,x:850,facing:-1},token:{exists:false,carrier:-1},goal:{exists:false},scoreboard:[0,0],rounds:[0,0]};
            const labels={cosmetics:[{body,weapon:weapon.id},{body,weapon:weapon.id}]};
            for(let attempt=0;attempt<100;attempt++){
              rigDraws=0;weaponDraws=0;drawFrame(oc,STAGES.datacenter,frame,labels);
              if((legacy||rigDraws>=20)&&weaponDraws>=2)break;
              await new Promise(r=>setTimeout(r,20));
            }
            if(!legacy&&rigDraws<20)throw Error(`Missing generated rig: ${body}/${weapon.id}`);
            if(weaponDraws<2)throw Error(`Missing weapon texture: ${body}/${weapon.id}`);
            if(n===0&&weapon===catalog.weapons[body][0]){const ic=idle.getContext('2d');ic.drawImage(off,410,375,96,80,0,0,96,80);ic.drawImage(off,774,375,96,80,96,0,96,80);}
            ctx.drawImage(off,405,325,128,150,n*128,0,128,150);ctx.drawImage(off,767,325,128,150,n*128,150,128,150);
          }
          rows.push({body,weapon:weapon.id,poses:5,facings:2,verifiedGeneratedRig:!legacy});
        }
        const stateLabel=document.createElement('p');stateLabel.textContent='wall slide / dive / KO (both facings)';section.append(stateLabel);
        const states=document.createElement('canvas');states.width=384;states.height=240;section.append(states);const sc=states.getContext('2d');
        for(const [n,patch] of [{wall:-1,onGround:false,vy:100},{diveT:.1,onGround:false,vy:800},{dead:true,respawnT:.3}].entries()){
          const off=document.createElement('canvas');off.width=1280;off.height=720;const oc=off.getContext('2d');
          const f={body,weapon:catalog.weapons[body][0].id,weaponMotionVersion:legacy?undefined:1,x:450,y:420,vx:0,vy:0,onGround:true,wall:0,facing:1,stun:0,swipeT:0,diveT:0,lastClashTick:-9999,dead:false,...patch};
          const frame={tick:500,roundStartTick:0,p0:f,p1:{...f,x:850,facing:-1,wall:patch.wall?1:0},token:{exists:false,carrier:-1},goal:{exists:false},scoreboard:[0,0],rounds:[0,0]};
          drawFrame(oc,STAGES.datacenter,frame,{cosmetics:[{body},{body}]});await new Promise(r=>setTimeout(r,35));drawFrame(oc,STAGES.datacenter,frame,{cosmetics:[{body},{body}]});
          sc.drawImage(off,405,355,128,120,n*128,0,128,120);sc.drawImage(off,767,355,128,120,n*128,120,128,120);
        }
      }
      return rows;
    },{origin,legacy});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Review layout overflow');
    await page.screenshot({path:path.join(output,`roster-${width}.png`),fullPage:true});
    await writeFile(path.join(output,`report-${width}.json`),JSON.stringify({width,rows,errors},null,2));
    await page.close();
  }
  if(errors.length)throw Error(errors.join('\n'));
  console.log(output);
}finally{await browser.close();await new Promise(r=>server.close(r));}
