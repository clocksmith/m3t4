// Matched-seed behavioral diagnostic, not a balance or release qualification.
// Run after npm -w sim run build. All metrics use observable transitions,
// not the planner's own claim that a tactic succeeded.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const sim = await import(pathToFileURL(resolve(option('--sim', 'sim/dist/index.js'))));
const seeds = option('--seeds', '7,43').split(',').map(Number);
const pairs = [
  ['standby', 'standby'], ['blitz', 'operator'], ['oracle', 'shipper'],
  ['incumbent', 'moonshot'], ['founder', 'disruptor'], ['intern', 'regulatory'],
  ['troll', 'acquirer'], ['pivot', 'unicorn'],
];
const rows = [];
for (const stage of Object.values(sim.STAGES)) for (const [a,b] of pairs) for (const seed of seeds) {
  const w = sim.createStepperWorld({ stage, seed });
  w.telemetry = [sim.emptyFighterTelemetry(), sim.emptyFighterTelemetry()];
  const brains = [sim.compileBrain(sim.STRATEGIES[a]), sim.compileBrain(sim.STRATEGIES[b])];
  const stats = [0,1].map(() => ({ ticks:0, stuckTicks:0, repeatedFailedTicks:0, stagnantWindows:0, windows:0, progressWindows:0, effective:{}, window:null, lastAction:null, repeated:0, anchor:null, lastMove:0 }));
  let timeouts=0, deliveries=0, hash=2166136261;
  while(w.tick < 28800 && w.matchWinner === -1) {
    const active = w.freeze <= 0 && w.roundPause <= 0;
    const before = w.fighters.map(f=>({...f}));
    const obs = active ? [sim.worldObservation(w,0),sim.worldObservation(w,1)] : null;
    const acts = active ? brains.map((brain,i)=>sim.runBrainForWorld(w,brain,i)) : [{},{}];
    const roundAge = w.tick - w.roundStartTick;
    const wasPause = w.roundPause > 0;
    const tokenBefore = w.gold?.carrier;
    for (const act of acts) {hash=Math.imul(hash ^ sim.packAction(act),16777619)>>>0;}
    sim.stepWorld(w,...acts);
    if (!wasPause && w.roundPause > 0 && roundAge >= sim.ROUND_TIMER_MAX_TICKS-1) timeouts++;
    if (!active) continue;
    for(let i=0;i<2;i++) {
      const s=stats[i], f=before[i], n=w.fighters[i], o=obs[i], act=acts[i];
      if(f.dead) { s.window=null;s.anchor=null;s.repeated=0;continue; }
      s.ticks++;
      if(!s.anchor || Math.hypot(f.x-s.anchor.x,f.y-s.anchor.y)>24) {s.anchor={x:f.x,y:f.y};s.lastMove=w.tick;}
      const stuck=w.tick-s.lastMove>90;
      if(stuck) s.stuckTicks++;
      const category=act.action ? (!f.onGround && act.down ? 'dive' : 'swipe') : act.down ? 'drop' : act.up ? 'jump' : act.left || act.right ? (((act.right?1:0)-(act.left?1:0))*Math.sign(o.dx)>=0?'approach':'retreat') : 'hold';
      const moved=Math.hypot(n.x-f.x,n.y-f.y)>0.5;
      const attack=n.lastAttackStartTick!==f.lastAttackStartTick;
      const scored=n.score>f.score;
      const killed=n.lastKillTick!==f.lastKillTick;
      deliveries+=Number(scored);
      const effective=category==='swipe'||category==='dive' ? attack : category==='jump' ? n.vy<f.vy-100 : category==='drop' ? n.y>f.y+0.5 : category==='hold' ? tokenBefore===i && (w.gold?.dwellT??0)>(o.token.dwellT??0) : moved;
      if(effective) s.effective[category]=(s.effective[category]??0)+1;
      const intent=o.self.hasToken?'deliver':o.opp.hasToken?'intercept':o.token.exists?'pickup':'combat';
      const tx=intent==='deliver'?o.goal.x:intent==='pickup'?o.token.x:o.opp.x;
      const ty=intent==='deliver'?o.goal.y+sim.STATS.bodyH/2:intent==='pickup'?o.token.y:o.opp.y;
      const distance=Math.hypot(f.x-tx,f.y-ty);
      const key=`${intent}:${o.goal.label}:${o.self.rounds}:${o.opp.rounds}`;
      if(!s.window || s.window.key!==key) s.window={key,start:w.tick,dist:distance,best:distance,x:f.x,y:f.y,minX:f.x,maxX:f.x,minY:f.y,maxY:f.y,attacks:0,progress:false,categories:new Set()};
      const win=s.window;
      win.best=Math.min(win.best,distance);win.minX=Math.min(win.minX,f.x);win.maxX=Math.max(win.maxX,f.x);win.minY=Math.min(win.minY,f.y);win.maxY=Math.max(win.maxY,f.y);win.attacks+=Number(attack);win.categories.add(category);
      win.progress ||= scored || killed || w.fighters[1-i].hp<before[1-i].hp || (!o.self.hasToken && w.gold?.carrier===i) || (w.gold?.dwellT??0)>o.token.dwellT;
      const progress=win.progress || win.dist-win.best>=60;
      if(category===s.lastAction) s.repeated++;else {s.repeated=1;s.lastAction=category;}
      // Repeated ineffective input: static movement/hold, or repeated attacks
      // without observable progress after 1.5s. A chase making distance is not failure.
      if(!progress && w.tick-win.start>=180 && ((stuck && s.repeated>=60) || (win.attacks>=3 && category==='swipe'))) s.repeatedFailedTicks++;
      if(w.tick-win.start>=240) {
        s.windows++;if(progress)s.progressWindows++;else s.stagnantWindows++;
        s.window=null;
      }
    }
  }
  rows.push({stage:stage.id,a,b,seed,ticks:w.tick,winner:w.matchWinner,rounds:w.fighters.map(f=>f.rounds),timeouts,deliveries,kills:w.killCounts.reduce((a,b)=>a+b,0),hash:hash.toString(16),fighters:stats.map(({window,anchor,lastAction,lastMove,repeated,...s})=>s)});
}
const all=rows.flatMap(r=>r.fighters);
const sum=k=>all.reduce((n,s)=>n+s[k],0);
const ticks=sum('ticks'), windows=sum('windows');
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const summary={matches:rows.length,completed:rows.filter(r=>r.winner!==-1).length,scoreCompleted:rows.filter(r=>r.winner!==-1&&r.timeouts===0).length,meanSeconds:mean(rows.map(r=>r.ticks/120)),timeouts:rows.reduce((n,r)=>n+r.timeouts,0),deliveries:rows.reduce((n,r)=>n+r.deliveries,0),kills:rows.reduce((n,r)=>n+r.kills,0),stuckRate:sum('stuckTicks')/ticks,repeatedFailedRate:sum('repeatedFailedTicks')/ticks,stagnantWindowRate:sum('stagnantWindows')/windows,progressWindowRate:sum('progressWindows')/windows,meanEffectiveActionKinds:mean(all.map(s=>Object.keys(s.effective).length)),decisionTicks:ticks};
const result={behaviorVersion:sim.BEHAVIOR_VERSION,seeds,summary,rows};
const out=option('--output',null);if(out)writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
