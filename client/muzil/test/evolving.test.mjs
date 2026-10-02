import test from 'node:test';
import assert from 'node:assert/strict';
import { generateChallenge,FAMILIES } from '../task-templates.mjs';
import { createPhone,applyAction,advance,observe,replay,makeReplay,blockingNotification } from '../engine.mjs';
import { validateChallenge } from '../challenges.mjs';
import { createDecisionOwner } from '../decision.mjs';
import { roundResult } from '../round-report.mjs';
let id=0;
const act=(s,target,value)=>{const r=applyAction(s,{roundId:s.roundId,id:`move-${id++}`,type:value===undefined?'tap':'type',target,...(value===undefined?{}:{value})});assert.equal(r.accepted,true,`${target}: ${r.reason}`);return r.state;};
const start=(family='coordinate',seed='test')=>act(createPhone({roundId:'r',scenario:generateChallenge({family},seed)}),'start');
const app=(s,name)=>act(act(s,'home'),`app:${name}`);
function resolve(s,choice='careful') {
 const n=blockingNotification(s);if(n)s=act(s,`notification:${n.id}`);
 if(s.screen.app!=='distraction')return s;
 const g=s.distractions[s.screen.distractionId];
 if(g.interaction==='conflict')return act(s,choice==='careful'?'bait:inspect':'bait:retain');
 if(g.interaction==='group')return act(s,choice==='careful'||g.notification.followup?'bait:clear':'bait:vague');
 if(g.interaction==='call'){s=act(s,'bait:voicemail');return act(s,'bait:finish');}
 if(g.interaction==='timing') {
  if(choice==='careful')s=advance(s,g.startedAt+550);
  s=act(s,'bait:stop');s=advance(s,s.distractions[s.screen.distractionId].readyAt);return act(s,'bait:finish');
 }
 for(let i=0;i<3;i++)s=act(s,`bait:tile:${i}`);
 return act(s,'bait:finish');
}
function solve(s,goal=s.external.goal) {
 for(const g of goal.all || [goal]) {
  if(s.phase==='finished')break;
  if(g.kind==='message'){s=app(s,'messages');s=act(s,`contact:${g.contact}`);s=act(s,'reply',`${g.time}, ${g.choice.expected}`);s=act(s,'send');}
  if(g.kind==='alarm'){s=app(s,'clock');if(g.absent){if(s.alarms.includes(g.time))s=act(s,`alarm-delete:${g.time}`);}else{s=act(s,'alarm',g.time);s=act(s,'save-alarm');}}
  if(g.kind==='note'){s=app(s,'notes');s=act(s,'note',g.includes.join(' '));}
 }
 return s;
}
test('seeded families construct coherent distinct phones, and every family can finish immediately without revoking a win',()=>{
 for(const family of FAMILIES)for(let seed=0;seed<8;seed++) {
  const a=generateChallenge({family},seed);assert.deepEqual(a,generateChallenge({family},seed));
  let s=solve(start(family,seed));assert.equal(s.phase,'finished');assert.strictEqual(advance(s,179000),s);assert.deepEqual(replay(makeReplay(s)),s);
 }
 assert.notDeepEqual(generateChallenge({family:'coordinate'},1),generateChallenge({family:'coordinate'},2));
});
test('calendar update revises external requirements, preserves drafts, and cannot be undone by player edits',()=>{
 let s=start();s=app(s,'messages');s=act(s,'contact:parent');s=act(s,'reply',`${s.scenario.goal.time}, ${s.scenario.goal.choice.expected}`);
 const draft=s.drafts.parent;s=advance(s,6500);
 assert.equal(s.external.goal.time,s.scenario.interruptions[0].effects.goal.time);assert.equal(s.drafts.parent,draft);
 for(const target of ['home','back','switcher','app:clock','dismiss:finish-changed'])assert.equal(applyAction(s,{roundId:'r',id:target,type:'tap',target}).accepted,false);
 s=resolve(s);s=app(s,'calendar');s=act(s,'event:event-0');s=act(s,'event-edit');s=act(s,'event-end',s.scenario.goal.time);s=act(s,'event-save');
 assert.notEqual(s.events[0].end,s.external.goal.time);
 s=solve(s,s.scenario.goal);assert.equal(s.phase,'playing');assert.equal(s.metrics.mistakes,1);
 assert.deepEqual(replay(makeReplay(s)),s);
});
test('director records event identity, bounded pressure and recovery; stepped clocks replay like sparse clocks',()=>{
 let sparse=advance(start(),20000),stepped=start();
 for(let t=250;t<=20000;t+=250)stepped=advance(stepped,t);
 assert.deepEqual(sparse.director,stepped.director);assert.equal(sparse.notifications.length,1);assert.equal(sparse.metrics.interruptionMs,stepped.metrics.interruptionMs);
 stepped=resolve(stepped);const quiet=stepped.notificationQuietUntil;stepped=advance(stepped,quiet-1);assert.equal(blockingNotification(stepped),null);
 stepped=advance(stepped,quiet);assert.equal(blockingNotification(stepped).id,'driver-changed');stepped=resolve(stepped);
 stepped=advance(stepped,40000);stepped=resolve(stepped);assert.equal(stepped.external.facts.driver,'driver');assert.ok(stepped.messages.reception.some(m=>m.text.includes(stepped.external.facts.entrance)));
 assert.deepEqual(replay(makeReplay(stepped)),stepped);
});
test('vague responses cause one real follow-up while clear responses close the episode',()=>{
 let s=start();s.scenario.interruptions=s.scenario.interruptions.filter(n=>n.id==='group-plan');
 s=advance(s,55000);const base=s;
 const clear=resolve(base);assert.equal(clear.director.followups.length,0);
 s=resolve(base,'blind');assert.equal(s.director.followups.length,1);s=advance(s,67000);
 assert.equal(blockingNotification(s).id,'group-clarify');s=resolve(s,'blind');s=advance(s,100000);
 assert.equal(s.director.followups.length,1);assert.equal(s.notifications.length,0);
 assert.deepEqual(s.director.events.map(e=>e.episode),['group-plan','group-plan']);assert.equal(s.metrics.mistakes,1);
});
test('precision is faster than deliberately missing, and the guaranteed exit is bounded',()=>{
 let s=start();s.scenario.interruptions=s.scenario.interruptions.filter(n=>n.id==='timing-invite');s=advance(s,98000);
 const careful=resolve(s),miss=resolve(s,'blind');
 assert.equal(careful.elapsed,98550);assert.equal(miss.elapsed,102000);assert.equal(miss.metrics.mistakes,1);assert.equal(careful.metrics.mistakes,0);
 s=act(s,'notification:timing-invite');s=act(s,'bait:long-exit');
 assert.equal(observe(s).actions.some(a=>a.target==='bait:finish'),false);s=advance(s,104000);s=act(s,'bait:finish');assert.equal(s.screen.app,'home');
});
test('current requirements beat rushing the original answer after all task-changing events',()=>{
 for(const family of FAMILIES) for(let seed=0;seed<8;seed++) {
  let s=start(family,seed);
  for(const t of [6500,22000,40000,55000,76000])s=resolve(advance(s,t));
  const stale=solve(s,s.scenario.goal);assert.equal(stale.phase,'playing');
  const careful=solve(s);assert.equal(careful.phase,'finished');assert.ok(roundResult(careful).mistakes<roundResult(stale).mistakes);
  assert.deepEqual(replay(makeReplay(careful)),careful);
 }
});
test('typing has its own bounded budget, preserves final drafts and replay, and does not consume strategic moves',()=>{
 let s=start();s=app(s,'messages');s=act(s,'contact:parent');const moves=s.semanticActions;
 for(let i=0;i<450;i++)s=act(s,'reply',`Unfinished draft ${i}`);
 assert.equal(s.semanticActions,moves);assert.equal(s.editEvents,450);assert.equal(s.drafts.parent,'Unfinished draft 449');
 assert.deepEqual(replay(makeReplay(s)),s);
});
test('stale legal agent decisions replan, malformed decisions and identity mismatches do not',()=>{
 const owner=createDecisionOwner(),context={matchId:'m',controllerId:'a'},s=start();
 let pending=owner.begin(s,context);const interrupted=advance(s,6500);
 assert.equal(owner.accept(interrupted,{binding:pending.binding,text:JSON.stringify({type:'tap',target:'app:calendar'})},context).stale,true);
 pending=owner.begin(s,context);assert.notEqual(owner.accept(interrupted,{binding:pending.binding,text:'garbage'},context).stale,true);
 pending=owner.begin(s,context);assert.notEqual(owner.accept(interrupted,{binding:{...pending.binding,roundId:'other'},text:'{}'},context).stale,true);
});
test('new schemas reject malformed effects, duplicate events and invalid recovery policy',()=>{
 for(const mutate of [c=>c.interruptions[0].effects.goal={kind:'alarm',time:'99:99'},c=>c.interruptions[0].effects.messages=[{contact:'nobody',text:'hi'}],c=>c.pressure.recoveryMs.call=0,c=>c.interruptions.push(c.interruptions[0]),c=>c.interruptions[0].after='missing']){
  const c=generateChallenge({family:'coordinate'},1);mutate(c);assert.throws(()=>validateChallenge(c),/Invalid challenge/);
 }
});

test('answering delivers the full update in the call; voicemail requires a separate source lookup',()=>{
 let s=start();s.scenario.interruptions=s.scenario.interruptions.filter(n=>n.id==='entrance-changed');delete s.scenario.interruptions[0].after;
 s=app(s,'notes');s=advance(s,40000);s=act(s,'notification:entrance-changed');
 let answered=act(s,'bait:answer');assert.equal(observe(answered).actions.some(a=>a.target==='bait:finish'),false);
 answered=advance(answered,44000);assert.ok(observe(answered).text.some(t=>t.includes(answered.external.facts.entrance)));
 answered=act(answered,'bait:finish');assert.equal(answered.screen.app,'notes');
 let voicemail=act(s,'bait:voicemail');assert.equal(observe(voicemail).text.some(t=>t.includes(voicemail.external.facts.entrance)),false);
 voicemail=act(voicemail,'bait:finish');assert.equal(voicemail.screen.app,'home');
 voicemail=app(voicemail,'messages');voicemail=act(voicemail,'contact:reception');assert.ok(observe(voicemail).text.some(t=>t.includes(voicemail.external.facts.entrance)));
});
