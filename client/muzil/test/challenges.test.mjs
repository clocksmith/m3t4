import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCatalog, validateChallenge, matchesTime } from '../challenges.mjs';
import { createPhone, applyAction, observe, makeReplay, replay, advance } from '../engine.mjs';
const catalog = JSON.parse(await readFile(new URL('../challenges.json',import.meta.url)));
const scenarios = parseCatalog(catalog).filter(c=>c.version===1);
let n = 0;
function act(s,target,value) { const result=applyAction(s,{roundId:s.roundId,id:`c${n++}`,type:value===undefined?'tap':'type',target,...(value===undefined?{}:{value})}); assert.equal(result.accepted,true,result.reason); return result.state; }
function run(s,steps) {
  for(const [kind,a,b] of steps) {
    s=act(s,'home');
    if(kind==='message') { s=act(s,'app:messages');s=act(s,`contact:${a}`);s=act(s,'reply',b);s=act(s,'send'); }
    if(kind==='alarm') { s=act(s,'app:clock');s=act(s,'alarm',a);s=act(s,'save-alarm'); }
    if(kind==='note') { s=act(s,'app:notes');s=act(s,'note',a); }
  }
  return s;
}
const solutions = [
 [['message','mom','5:40 PM, side entrance']],
 [['message','mom','3:15 PM, garden gate']],
 [['message','sam','Locker 24, code 6831']],
 [['alarm','06:00']],
 [['message','lee','11:30 AM, blue room']],
 [['note','soap, lemons, rice, coffee']],
 [['message','alex','19:45, platform 6']],
 [['message','sam','42 Willow Lane, apartment 3']],
];
test('every legacy JSON challenge completes using shared controls and reproduces through replay',()=>{
 assert.equal(scenarios.length,solutions.length);
 scenarios.forEach((scenario,i)=>{
  let s=act(createPhone({roundId:`json-${i}`,scenario}),'start');
  s=run(s,solutions[i].slice(0,-1)); assert.equal(s.phase,'playing',scenario.id);
  s=run(s,solutions[i].slice(-1)); assert.equal(s.phase,'finished',scenario.id);
  assert.deepEqual(replay(makeReplay(s)),s);
 });
});
test('legacy challenges have one result, with information gathered across apps',()=>{
 for(const scenario of scenarios) assert.ok(['message','alarm','note'].includes(scenario.goal.kind));
 let s=act(createPhone({roundId:'shift',scenario:scenarios[3]}),'start');
 s=run(s,[['alarm','06:50']]); assert.equal(s.phase,'playing');
 s=run(s,[['alarm','06:00']]); assert.equal(s.phase,'finished');
 let expired=act(createPhone({roundId:'expired',scenario:scenarios[7]}),'start');
 expired=advance(expired,150000);assert.equal(expired.phase,'expired');assert.deepEqual(replay(makeReplay(expired)),expired);
});
test('new contacts and multiple calendar events are observable without leaking goal predicates',()=>{
 const scenario=structuredClone(scenarios[4]);scenario.initial.calendar.push({title:'Lunch',start:'13:00',end:'14:00',note:'Bring a sandwich.'});
 let s=act(createPhone({roundId:'visible',scenario}),'start');
 assert.equal(JSON.stringify(observe(s)).includes('blue room'),false);
 s=act(s,'app:messages');assert.ok(observe(s).actions.some(a=>a.target==='contact:lee'));assert.equal(observe(s).actions.some(a=>a.target==='contact:mom'),false);
 s=act(s,'home');s=act(s,'app:calendar');assert.ok(observe(s).text.some(t=>t.includes('Lunch')));assert.equal(observe(s).text.some(t=>t.includes('blue room')),false);s=act(s,'home');s=act(s,'app:notes');assert.ok(observe(s).text.some(t=>t.includes('blue room')));
});
test('malformed JSON challenges fail closed before a round starts',()=>{
 const invalid = [
 c=>c.goal={all:[]},c=>c.goal={kind:'execute',code:'anything'},c=>c.goal={all:[],any:[]},
 c=>c.goal={kind:'message',contact:'missing',includes:['x']},c=>c.durationMs=1,
 c=>c.initial.contacts[0].id='constructor',c=>c.initial.alarms=['25:00'],
 c=>c.interruptions[0].contact='missing',c=>c.goal={kind:'alarm',time:'6:20'},
 ];
 for(const mutate of invalid) { const c=structuredClone(scenarios[0]);mutate(c);assert.throws(()=>validateChallenge(c),/Invalid challenge/); }
 assert.throws(()=>parseCatalog({...catalog,challenges:[scenarios[0],scenarios[0]]}),/unique/);
 assert.equal(matchesTime('17:40 AM','17:40'),false);
});
