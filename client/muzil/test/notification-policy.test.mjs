import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateChallenge,parseCatalog} from '../challenges.mjs';
import {generateChallenge} from '../task-templates.mjs';
import {createPhone,applyAction,advance,observe,blockingNotification,lockedDistraction,replay,makeReplay} from '../engine.mjs';
import {notificationGesture,notificationActions} from '../notification-policy.mjs';
import {roundReport} from '../round-report.mjs';
import {bindNotificationGestures} from '../notification-gestures.mjs';
const template=parseCatalog(JSON.parse(readFileSync(new URL('../challenges.json',import.meta.url)))).find(c=>c.family==='coordinate');
let serial=0;
function act(s,target,value,id=`action-${serial++}`){const result=applyAction(s,{id,roundId:s.roundId,type:value===undefined?'tap':'type',target,...(value===undefined?{}:{value})});assert.ok(result.accepted,`${target}: ${result.reason}`);return result.state;}
function scenario(id='entrance-changed',policy='openRequired',resolution=false){
 const c=generateChallenge(template,'policy-test');c.interruptions=c.interruptions.filter(n=>n.id===id);c.followups=[];c.notificationOverrides={[id]:{...c.notificationOverrides[id],policy,requireResolution:resolution}};
 delete c.interruptions[0].after;c.interruptions[0].at=1000;delete c.interruptions[0].trigger;
 return validateChallenge(c);
}
const start=c=>act(createPhone({roundId:'policy-round',scenario:c}),'start');
const reject=(s,target)=>assert.equal(applyAction(s,{roundId:s.roundId,id:`rejected-${serial++}`,type:'tap',target}).accepted,false,target);
test('opening and completing are independent; engine and visible controls obey the same policy',()=>{
 let s=advance(start(scenario()),1000),n=s.notifications[0];
 for(const target of ['home','back','switcher','app:notes','dismiss:entrance-changed','notice:entrance-changed:defer'])reject(s,target);
 assert.equal(notificationGesture(s,n,'swipeUp'),null);
 assert.equal(notificationGesture(s,n,'swipeDown'),'notification:entrance-changed');
 s=act(s,'notification:entrance-changed');assert.equal(lockedDistraction(s),false);
 assert.ok(observe(s).actions.some(a=>a.target==='bait:leave'));
 s=act(s,'bait:leave');assert.equal(s.screen.app,'home');assert.equal(s.notificationHistory[0].consequence,'leave');
 assert.deepEqual(replay(makeReplay(s)),s);
});
test('explicit resolution requirements lock follow-through; opening alone no longer implies this',()=>{
 let s=advance(start(scenario('photo-tag','openRequired',true)),1000);
 s=act(s,'notification:photo-tag');assert.equal(lockedDistraction(s),true);
 for(const target of ['home','back','switcher','bait:leave'])reject(s,target);
 for(let i=0;i<3;i++)s=act(s,`bait:tile:${i}`);
 s=act(s,'bait:finish');assert.equal(lockedDistraction(s),false);assert.deepEqual(replay(makeReplay(s)),s);
});
test('optional dismissal retains changed requirements and messages; history is replayed',()=>{
 let s=advance(start(scenario('entrance-changed','optional')),1000);
 const goal=structuredClone(s.external.goal),messages=structuredClone(s.messages.reception);
 assert.equal(blockingNotification(s),undefined);
 s=act(s,'notice:entrance-changed:expand');assert.equal(s.notifications[0].expanded,true);
 s=act(s,'notice:entrance-changed:dismiss');assert.equal(s.notifications.length,0);
 assert.deepEqual(s.external.goal,goal);assert.deepEqual(s.messages.reception,messages);
 assert.equal(s.notificationHistory[0].consequence,'dismissed');assert.deepEqual(replay(makeReplay(s)),s);
});
test('handle-first exposes its permitted choices and releases only through them',()=>{
 let s=advance(start(scenario('group-plan','handleFirst')),1000);
 const available=notificationActions(s,s.notifications[0]).map(a=>a.label);
 assert.ok(available.includes('Read'));assert.ok(available.includes('Later'));reject(s,'home');reject(s,'notice:group-plan:dismiss');
 s=act(s,'notice:group-plan:later');assert.equal(s.notifications.length,0);s=act(s,'app:notes');assert.equal(s.screen.app,'notes');
});
test('call choices can handle a banner directly without forcing the whole call',()=>{
 const c=scenario();c.notificationPolicies.call={blocksPhone:true,requireOpen:false,requireResolution:false,gestures:{tap:'answer',swipeDown:'answer'},controls:['answer','decline']};c.notificationOverrides['entrance-changed'].policy='call';
 let s=advance(start(c),1000);s=act(s,'notice:entrance-changed:decline');assert.equal(s.distractions['entrance-changed'].route,'voicemail');
 s=act(s,'bait:leave');assert.equal(s.screen.app,'home');assert.deepEqual(replay(makeReplay(s)),s);
});
test('exact draft text survives interrupted typing, app switches, sending and replay',()=>{
 let s=start(scenario());s=act(act(s,'app:messages'),'contact:driver');
 const first='Meet me at the gar',full='  Meet me at the garden entrance — 4:35 PM.\n钥匙, badge, lunch!  ';
 s=act(s,'reply',first);s=advance(s,1000);assert.equal(s.drafts.driver,first);
 s=act(s,'notification:entrance-changed');s=act(s,'bait:leave');s=act(s,'reply',full);
 s=act(act(act(s,'home'),'app:messages'),'contact:driver');assert.equal(s.drafts.driver,full);
 s=act(s,'send');assert.equal(s.sent.at(-1).text,full);
 assert.deepEqual(replay(makeReplay(s)),s);
});
test('classification measures useful handling separately; it does not add mistakes',()=>{
 let task=advance(start(scenario()),1000);task=advance(task,3000);task=act(task,'notification:entrance-changed');task=act(task,'bait:answer');task=advance(task,7000);
 assert.equal(task.metrics.taskUpdateMs,6000);assert.equal(task.metrics.mistakes,0);
 assert.match(roundReport(task),/6 seconds handling task updates and 0 seconds on unrelated detours/);
 let detour=advance(start(scenario('photo-tag')),1000);detour=act(detour,'notification:photo-tag');detour=advance(detour,4000);
 assert.equal(detour.metrics.detourMs,3000);assert.equal(detour.metrics.mistakes,0);
});
test('sparse and stepped clocks preserve event ordering, classification and bounded backlog',()=>{
 const c=generateChallenge(template,'pressure-test');
 let sparse=start(c),stepped=start(c);sparse=advance(sparse,150000);
 for(let t=250;t<=150000;t+=250)stepped=advance(stepped,t);
 assert.deepEqual(sparse.director,stepped.director);assert.deepEqual(sparse.metrics,stepped.metrics);assert.deepEqual(sparse.notifications,stepped.notifications);
 assert.ok(sparse.notifications.length<=c.notificationDefaults.maxPending);
 assert.deepEqual(replay(makeReplay(stepped)),stepped);
});
test('schema rejects impossible policies and invalid tuning before starting',()=>{
 for(const mutate of [
  c=>{c.notificationPolicies.openRequired.gestures={tap:'none'};c.notificationPolicies.openRequired.controls=[];},
  c=>c.notificationPolicies.openRequired.controls=['dismiss'],
  c=>c.notificationPolicies.openRequired.gestures.swipeUp='dismiss',
  c=>c.notificationOverrides['entrance-changed'].policy='missing',
  c=>c.notificationDefaults.maxSimultaneousBlocking=0,
  c=>c.notificationDefaults.gestureThresholds.distancePx=0,
  c=>c.notificationOverrides['entrance-changed'].resolutionTimingMs={answer:-1},
 ]){const c=scenario();mutate(c);assert.throws(()=>validateChallenge(c),/Invalid challenge/);}
});
test('new gesture actions retain duplicate-action and replay checks',()=>{
 let s=advance(start(scenario('photo-tag','optional')),1000);s=act(s,'notice:photo-tag:expand',undefined,'swipe-1');
 const result=applyAction(s,{roundId:s.roundId,id:'swipe-1',type:'tap',target:'notice:photo-tag:expand'});assert.equal(result.reason,'Duplicate action');
 const record=makeReplay(s);record.log.at(-1).action.target='home:made-up';assert.throws(()=>replay(record),/Invalid replay/);
});
function gestureHarness(){
 const handlers=new Map(),actions=[],n={id:'notice'};
 const banner={dataset:{notification:n.id},isConnected:true};
 const target={closest:()=>banner,setPointerCapture:()=>{}};
 const root={addEventListener:(type,fn)=>handlers.set(type,fn)};
 bindNotificationGestures(root,{getNotification:()=>n,getThresholds:()=>({distancePx:40,axisRatio:1}),resolve:(_,g)=>g,dispatch:a=>actions.push(a)});
 const fire=(type,extra={})=>{const event={target,pointerId:1,button:0,clientX:100,clientY:100,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.get(type)?.(event);return event;};
 return {actions,fire};
}
test('completed swipes dispatch exactly once; cancelled gestures and synthetic taps do not',()=>{
 const {actions,fire}=gestureHarness();fire('pointerdown');fire('pointerup',{clientY:160});assert.deepEqual(actions,['swipeDown']);assert.equal(fire('click').stopped,true);
 fire('pointerdown');fire('pointercancel');fire('pointerup',{clientY:170});assert.equal(actions.length,1);assert.equal(fire('click').stopped,true);
 fire('pointerdown');fire('lostpointercapture');fire('pointerup',{clientX:0});assert.equal(actions.length,1);
 assert.equal(fire('click',{detail:0}).stopped,undefined,'keyboard clicks remain available');
});
test('small pointer motion remains a tap; another pointer cannot complete a gesture',()=>{
 const {actions,fire}=gestureHarness();fire('pointerdown');fire('pointerup',{clientY:120});assert.equal(actions.length,0);assert.equal(fire('click').stopped,undefined);
 fire('pointerdown');fire('pointerup',{pointerId:2,clientX:0});assert.equal(actions.length,0);fire('pointercancel');
});

test('arrival tuning and effects in overrides are validated and used by the director',()=>{
 const c=scenario();c.notificationOverrides['entrance-changed'].at=7000;
 let s=start(c);s=advance(s,6999);assert.equal(s.notifications.length,0);s=advance(s,7000);assert.equal(s.notifications[0].at,7000);
 c.notificationOverrides['entrance-changed'].effects={messages:[{contact:'missing',text:'hello'}]};assert.throws(()=>validateChallenge(c),/external messages/);
});
test('a quiet window never unlocks a blocking banner that has already arrived',()=>{
 const c=generateChallenge(template,'two-blockers');c.notificationDefaults.maxSimultaneousBlocking=2;
 c.interruptions=c.interruptions.filter(n=>['driver-changed','reminder-request'].includes(n.id));c.followups=[];
 c.notificationOverrides=Object.fromEntries(c.interruptions.map(n=>[n.id,{...c.notificationOverrides[n.id],at:n.id==='driver-changed'?1000:4000}]));
 for(const n of c.interruptions){delete n.after;delete n.trigger;}
 let s=advance(start(c),5000);assert.equal(s.notifications.length,2);
 s=act(s,'notification:driver-changed');assert.ok(s.notificationQuietUntil>s.elapsed);
 assert.equal(blockingNotification(s).id,'reminder-request');reject(s,'home');assert.deepEqual(replay(makeReplay(s)),s);
});
