// Controlled navigation diagnostics. No production stage, stats or brain data are edited.
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key)+1] : fallback;
const outputPath = option('--output', null);
if (outputPath && existsSync(outputPath)) throw new Error(`refusing to overwrite evaluation evidence: ${outputPath}`);
const sim = await import(pathToFileURL(resolve(option('--sim', 'sim/dist/index.js'))));
const heldOut = args.includes('--held-out');
const validation = args.includes('--validation');
const developmentNames = ['standby', 'intern', 'blitz', 'regulatory', 'shipper'];
const names = validation ? sim.STRATEGY_NAMES : heldOut ? sim.STRATEGY_NAMES.filter(n => !developmentNames.includes(n)) : developmentNames;
// Frozen unseen layout: unlike production stages, the two side platforms have
// different heights and the middle stepping stones are staggered horizontally.
const staggered = {
  id:'heldout-staggered', name:'Held-out staggered fixture',
  platforms:[
    {x:56,y:640,w:1168,h:80,solid:true},
    {x:350,y:470,w:34,h:170,solid:true}, {x:900,y:500,w:34,h:140,solid:true},
    {x:100,y:520,w:220,h:14,solid:false}, {x:910,y:430,w:220,h:14,solid:false},
    {x:400,y:390,w:200,h:14,solid:false}, {x:700,y:320,w:180,h:14,solid:false},
    {x:540,y:180,w:200,h:14,solid:false},
  ],
  goals:[{x:200,y:490,sx:200,sy:472,label:'LEFT'}, {x:1030,y:400,sx:1030,sy:382,label:'RIGHT'}, {x:640,y:150,sx:640,sy:132,label:'TOP'}],
  spawnL:{x:280,y:590}, spawnR:{x:1000,y:590},
};
// Second unseen layout, frozen after exploratory cohorts and never used to tune.
const terraces = {
  id:'validation-terraces', name:'Untouched validation terraces',
  platforms:[
    {x:56,y:640,w:1168,h:80,solid:true},
    {x:400,y:490,w:34,h:150,solid:true}, {x:850,y:460,w:34,h:180,solid:true},
    {x:140,y:500,w:220,h:14,solid:false}, {x:920,y:500,w:200,h:14,solid:false},
    {x:520,y:420,w:200,h:14,solid:false}, {x:300,y:300,w:220,h:14,solid:false},
    {x:760,y:290,w:200,h:14,solid:false}, {x:560,y:170,w:180,h:14,solid:false},
  ],
  goals:[{x:250,y:470,sx:250,sy:452,label:'LEFT'}, {x:1020,y:470,sx:1020,sy:452,label:'RIGHT'}, {x:650,y:140,sx:650,sy:122,label:'TOP'}],
  spawnL:{x:280,y:590}, spawnR:{x:1000,y:590},
};
const stages = validation ? [terraces] : heldOut ? [staggered] : Object.values(sim.STAGES);
const seed = validation ? 104729 : heldOut ? 113 : 7;
const rows = [];
for (const stage of stages) for (const name of names) for (const goal of stage.goals) for (const startX of [280,640,1000]) {
  const w = sim.createStepperWorld({stage,seed});
  Object.assign(w.fighters[0],{x:startX,y:612,onGround:true});
  Object.assign(w.fighters[1],{dead:true,respawnT:999});
  w.gold={x:startX,y:612,vx:0,vy:0,carrier:0,dwellT:0};
  w.goal={...goal,timer:1000};
  const brain = sim.compileBrain(sim.STRATEGIES[name]);
  const distance = f => Math.hypot(f.x-goal.x,f.y-(goal.y+sim.STATS.bodyH/2));
  const stats = {turns:0,jumps:0,returningJumps:0,dropStarts:0,returningDrops:0,dwellResets:0,maxDwell:0,stagnantWindows:0,oscillationWindows:0,failedAttackWindows:0,maxStagnantTicks:0};
  let lastSign=0, jump=null, drop=null, lastDwell=0, window=null, stagnantRun=0;
  const evidence=[];
  while(w.tick<3600 && w.fighters[0].score===0) {
    const f={...w.fighters[0]}, act=sim.runBrainForWorld(w,brain,0);
    const sign=(act.right?1:0)-(act.left?1:0);
    if(sign && lastSign && sign!==lastSign) stats.turns++;
    if(sign)lastSign=sign;
    if(!window)window={tick:w.tick,distance:distance(f),turns:stats.turns,attacks:0,x:f.x,y:f.y};
    sim.stepWorld(w,act,{});
    const n=w.fighters[0], dwell=w.gold?.dwellT??0;
    if(f.onGround&&!n.onGround&&n.vy<f.vy-100) {stats.jumps++;jump={x:f.x,y:f.y,tick:w.tick};}
    if(act.down&&f.onGround&&!n.onGround&&n.vy>0) {stats.dropStarts++;drop={x:f.x,y:f.y,tick:w.tick};}
    if(n.onGround&&!f.onGround) {
      for(const [key,attempt] of [['returningJumps',jump],['returningDrops',drop]]) {
        if(attempt&&Math.hypot(n.x-attempt.x,n.y-attempt.y)<48&&!n.score) {
          stats[key]++;
          if(evidence.length<12)evidence.push({class:key,start:attempt.tick,end:w.tick,from:[attempt.x,attempt.y],to:[n.x,n.y]});
        }
      }
      jump=null;drop=null;
    }
    if(lastDwell>0&&dwell===0&&!n.score) {
      stats.dwellResets++;
      if(evidence.length<12)evidence.push({class:'dwell-reset',tick:w.tick,heldSeconds:lastDwell,x:n.x,y:n.y});
    }
    lastDwell=dwell;stats.maxDwell=Math.max(stats.maxDwell,dwell);
    window.attacks+=Number(n.lastAttackStartTick!==f.lastAttackStartTick);
    if(w.tick-window.tick>=240) {
      const stagnant=window.distance-distance(n)<36 && !n.score;
      if(stagnant) {
        stats.stagnantWindows++;stagnantRun+=240;
        if(stats.turns-window.turns>=4)stats.oscillationWindows++;
        if(window.attacks>=3)stats.failedAttackWindows++;
        stats.maxStagnantTicks=Math.max(stats.maxStagnantTicks,stagnantRun);
        if(evidence.length<12)evidence.push({class:stats.turns-window.turns>=4?'route-oscillation':'no-net-progress',start:window.tick,end:w.tick,turns:stats.turns-window.turns,from:[window.x,window.y],to:[n.x,n.y]});
      } else stagnantRun=0;
      window=null;
    }
  }
  rows.push({stage:stage.id,name,goal:goal.label,startX,seed,ticks:w.tick,scored:w.fighters[0].score>0,...stats,evidence});
}
const sum=k=>rows.reduce((n,r)=>n+r[k],0);
const summary={routes:rows.length,scored:rows.filter(r=>r.scored).length,meanSeconds:sum('ticks')/rows.length/120,turns:sum('turns'),jumps:sum('jumps'),returningJumps:sum('returningJumps'),returningDrops:sum('returningDrops'),dwellResets:sum('dwellResets'),stagnantWindows:sum('stagnantWindows'),oscillationWindows:sum('oscillationWindows'),failedAttackWindows:sum('failedAttackWindows'),maxStagnantTicks:Math.max(...rows.map(r=>r.maxStagnantTicks))};
const result={behaviorVersion:sim.BEHAVIOR_VERSION,goalDwellSeconds:sim.GOAL_DWELL_S,heldOut,validation,seed,names,summary,rows};
if(outputPath)writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary,null,2));
