import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhone, applyAction, advance, observe, replay, makeReplay } from '../engine.mjs';
import { SCENARIOS } from '../scenarios.mjs';
import { readFile } from 'node:fs/promises';
const catalog = JSON.parse(await readFile(new URL('../challenges.json',import.meta.url)));
let serial = 0;
function act(state,target,type='tap',value) {
  const result = applyAction(state,{roundId:state.roundId,id:`d${serial++}`,type,target,...(value === undefined?{}:{value})});
  assert.equal(result.accepted,true,`${target}: ${result.reason}`); return result.state;
}
function enter(kind) {
  const scenario=structuredClone(SCENARIOS[0]);
  scenario.interruptions=[{id:'temptation',at:1000,app:'feed',title:'Just one thing',body:'You were tagged',distraction:kind}];
  let s=act(createPhone({roundId:'distraction-round',scenario}),'start');
  s=act(s,'app:messages');s=act(s,'contact:mom');s=act(s,'reply','type','Unfinished draft');
  s=advance(s,1100);return act(s,'notification:temptation');
}
test('photo reveal rewards a detour without winning the task; leaving restores the draft',()=>{
  let s=enter('reveal');
  s=act(s,'bait:tile:0');
  assert.equal(observe(s).actions.some(a=>a.target==='bait:tile:0'),false);
  s=act(s,'bait:tile:1');s=act(s,'bait:tile:2');
  assert.equal(s.distractions.temptation.done,true); assert.equal(s.phase,'playing');
  s=advance(s,14000);s=act(s,'bait:leave');
  assert.deepEqual(s.screen,{app:'messages',contact:'mom'});assert.equal(s.drafts.mom,'Unfinished draft');
  assert.equal(s.elapsed,14000);assert.equal(s.distractionTaps,3);
  assert.deepEqual(replay(makeReplay(s)),s);
  assert.equal(applyAction(s,{roundId:s.roundId,id:'late-tile',type:'tap',target:'bait:tile:0'}).accepted,false);
  s=act(s,'reply','type','5:40 PM');s=act(s,'send');assert.equal(s.phase,'finished');
});
test('matching cards hide their values until turned and replay every match',()=>{
  let s=enter('pairs');
  assert.equal(observe(s).text.some(t=>t.includes('Card 1: face down')),true);
  const cards=s.distractions.temptation.cards;
  for(const symbol of new Set(cards)) for(const i of cards.map((v,i)=>v===symbol?i:-1).filter(i=>i>=0)) s=act(s,`bait:tile:${i}`);
  assert.equal(s.distractions.temptation.done,true);
  assert.deepEqual(replay(makeReplay(s)),s);
  s=act(s,'bait:again');assert.equal(s.distractions.temptation.done,false);assert.equal(s.distractions.temptation.attempt,1);
  s=act(s,'home');assert.equal(s.screen.app,'home');
});
test('timing result uses elapsed game time, has no fake near-miss, and expires with the main round',()=>{
  let s=enter('timing');
  s=act(s,'bait:stop');assert.equal(s.distractions.temptation.done,false);assert.equal(s.distractions.temptation.stopped,100);
  s=act(s,'bait:again');s=advance(s,s.elapsed+550);s=act(s,'bait:stop');
  assert.equal(s.distractions.temptation.done,true);assert.equal(s.distractions.temptation.stopped,50);
  s=advance(s,180000);assert.equal(s.phase,'expired');assert.deepEqual(replay(makeReplay(s)),s);
  assert.equal(applyAction(s,{roundId:s.roundId,id:'after-time',type:'tap',target:'bait:again'}).accepted,false);
});
test('forceful notifications block app controls for humans and agents, but allow the outside task note',()=>{
  const scenario=catalog.challenges[0];
  let s=act(createPhone({roundId:'forceful',scenario}),'start');
  s=act(s,'app:messages');s=act(s,'contact:mom');s=act(s,'reply','type','My draft');
  s=advance(s,7100);
  assert.deepEqual(observe(s).actions.map(a=>a.target),['notification:group-urgent','dismiss:group-urgent','recall']);
  assert.equal(applyAction(s,{roundId:s.roundId,id:'hidden-send',type:'tap',target:'send'}).accepted,false);
  const screen=structuredClone(s.screen);s=act(s,'recall');assert.deepEqual(s.screen,screen);
  assert.ok(observe(s).text.some(t=>t.includes('m3t4.ai task:')));
  s=act(s,'dismiss:group-urgent');assert.equal(s.drafts.mom,'My draft');
  assert.ok(observe(s).actions.some(a=>a.target==='send'));
  assert.deepEqual(replay(makeReplay(s)),s);
});
