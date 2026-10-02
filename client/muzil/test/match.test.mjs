import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchOwner,compareResults } from '../match.mjs';
import { obligations } from '../round-report.mjs';
import { createPhone,applyAction,makeReplay,advance } from '../engine.mjs';
const templates=['coordinate','prepare','repair'].map(family=>({family}));
function pair() {
 let now=1000;const queue=[],starts=[[],[]],errors=[];
 const peers=[0,1].map(i=>createMatchOwner({templates,now:()=>now,id:()=>`match-${i}`,send:m=>queue.push([1-i,structuredClone(m)]),onStart:x=>starts[i].push(x)}));
 const flush=()=>{while(queue.length){const [i,m]=queue.shift();try{peers[i].receive(m);}catch(e){errors.push(e);}}};
 return {peers,starts,errors,flush,tick:()=>{now+=3000;peers.forEach(p=>p.tick());},invite:()=>{peers[0].invite();flush();peers[1].accept();flush();}};
}
function result(start,win) {
 let s=createPhone({roundId:start.roundId,scenario:start.scenario});
 const act=(target,value)=>{const r=applyAction(s,{roundId:s.roundId,id:crypto.randomUUID(),type:value===undefined?'tap':'type',target,...(value===undefined?{}:{value})});assert.ok(r.accepted,r.reason);s=r.state;};
 act('start');
 if(!win)return makeReplay(advance(s,180000));
 for(const g of s.external.goal.all || [s.external.goal]) {
  if(s.phase==='finished')break;
  act('home');
  if(g.kind==='message'){act('app:messages');act(`contact:${g.contact}`);act('reply',`${g.time}, ${g.choice.expected}`);act('send');}
  if(g.kind==='alarm'){act('app:clock');if(g.absent){if(s.alarms.includes(g.time))act(`alarm-delete:${g.time}`);}else{act('alarm',g.time);act('save-alarm');}}
  if(g.kind==='note'){act('app:notes');act('note',g.includes.join(' '));}
 }
 return makeReplay(s);
}
test('shared countdown, three distinct task families, persistent match and best-of-three score',()=>{
 const p=pair();p.invite();assert.equal(p.errors.length,0);assert.equal(p.peers[0].current.phase,'countdown');assert.equal(p.peers[1].current.phase,'countdown');
 for(let round=0;round<3;round++) {
  p.tick();assert.deepEqual(p.starts[0][round],p.starts[1][round]);assert.equal(p.starts[0][round].scenario.family,templates[round].family);
  const records=p.peers.map((_,i)=>result(p.starts[i][round],i===(round===1?1:0)));
  p.peers[0].complete(records[0]);p.peers[1].complete(records[1]);p.flush();assert.equal(p.errors.length,0,p.errors[0]?.message);
  assert.deepEqual(p.peers[0].current.score,p.peers[1].current.score.toReversed());
  if(round<2){p.peers[1].ready();p.flush();assert.equal(p.peers[0].current.phase,'intermission');p.peers[0].ready();p.flush();}
 }
 assert.equal(p.peers[0].current.phase,'finished');assert.deepEqual(p.peers[0].current.score,[2,1]);assert.equal(p.peers[0].current.history.length,3);
});
test('two wins end the series, duplicate/old messages cannot add points, disconnect preserves score',()=>{
 const p=pair();p.invite();let first;
 for(let round=0;round<2;round++) {
  p.tick();const a=result(p.starts[0][round],true),b=result(p.starts[1][round],false);
  first ||= {protocol:'muzil-match/1',raceId:'match-0',round:0,type:'result',record:b};
  p.peers[0].complete(a);p.peers[1].complete(b);p.flush();p.peers[0].receive(first);
  if(round===0){p.peers[0].ready();p.peers[1].ready();p.flush();}
 }
 assert.equal(p.peers[0].current.phase,'finished');assert.deepEqual(p.peers[0].current.score,[2,0]);p.peers[0].disconnect();assert.deepEqual(p.peers[0].current.score,[2,0]);
});
test('replay verification rejects forged clocks/events and score only uses distinct obligations then mistakes',()=>{
 const p=pair();p.invite();p.tick();const record=result(p.starts[1][0],true);
 const message={protocol:'muzil-match/1',raceId:'match-0',round:0,type:'result',record};
 assert.throws(()=>p.peers[0].receive({...message,record:{...record,directorEvents:[{id:'invented'}]}}),/director/);
 assert.throws(()=>p.peers[0].receive({...message,record:{...record,elapsed:-1}}),/Invalid/);
 const stopped={...record,log:record.log.slice(0,1),ending:'lost'};
 assert.throws(()=>p.peers[0].receive({...message,record:stopped}),/does not finish/);
 const a={finished:false,elapsed:180000,obligations:2,mistakes:4},b={...a,obligations:1,mistakes:0};assert.equal(compareResults(a,b),1);assert.equal(compareResults(a,{...a,mistakes:5}),1);assert.equal(compareResults(a,a),0);
});

test('partial progress counts an obligation once even if a goal tree repeats it',()=>{
 const alarm={kind:'alarm',time:'06:00'};
 assert.equal(obligations({all:[alarm,{time:'06:00',kind:'alarm'}]},{alarms:['06:00']}),1);
});

test('local departure works after transport loss',()=>{
 let disconnected=false;
 const owner=createMatchOwner({templates,send:()=>{if(disconnected)throw new Error('offline');}});
 owner.invite();disconnected=true;owner.disconnect();assert.doesNotThrow(()=>owner.leave());assert.equal(owner.current,null);
});
