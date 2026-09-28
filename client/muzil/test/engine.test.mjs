import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPhone, applyAction, observe, advance, makeReplay, replay } from '../engine.mjs';
import { SCENARIOS } from '../scenarios.mjs';
import { LocalController, parseDecision, actionPrompt } from '../controller.mjs';
let n = 0;
const tap = (s, target, extra = {}) => applyAction(s, { roundId:s.roundId, id:`a${++n}`, type:'tap', target, ...extra }).state;
const type = (s, target, value) => tap(s, target, { type:'type', value });
const start = () => tap(createPhone({ roundId:'round-a' }), 'start');
function reply(s, text) { s = tap(s, 'app:messages'); s = tap(s, 'contact:mom'); s = type(s,'reply',text); return tap(s,'send'); }
test('outcome uses resulting recipient and current time, not a click checklist', () => {
  const s = reply(start(),'Pick me up at 5:40 PM, please.');
  assert.equal(s.phase,'finished'); assert.equal(s.log.some(e=>e.action.target === 'app:calendar'),false);
  const wrong = reply(start(),'Pick me up at 5:20 PM.'); assert.equal(wrong.phase,'playing');
  assert.equal(reply(start(),'5:40 PM or 5:20 PM?').phase,'playing');
});
test('relevant notification can supply the answer without Calendar', () => {
  let s = advance(start(),7000); assert.ok(observe(s).text.some(t=>t.includes('5:40 PM')));
  s = tap(s,'dismiss:calendar-update'); s = reply(s,'5:40 pm'); assert.equal(s.phase,'finished');
});
test('hidden evaluator facts and future notifications do not appear in a home observation', () => {
  const o = observe(start()); assert.equal(JSON.stringify(o).includes('17:40'),false); assert.equal(JSON.stringify(o).includes('skillet'),false);
  const after = observe(advance(start(),12500)); assert.equal(after.text.some(t=>t.includes('5:40 PM')),false);
});
test('duplicate send, repeated taps, stale rounds, and wrong contextual targets cannot advance outcome', () => {
  let s = start(); s = tap(s,'app:messages'); s = tap(s,'contact:group'); s = type(s,'reply','5:40 PM');
  const send = { roundId:s.roundId,id:'send-once',type:'tap',target:'send',screen:{app:'messages',contact:'group'} };
  s = applyAction(s,send).state; assert.equal(s.phase,'playing'); assert.equal(s.sent.length,1);
  assert.equal(applyAction(s,send).accepted,false); assert.equal(applyAction(s,{...send,id:'new-id'}).accepted,false);
  const fresh = createPhone({roundId:'round-b'}); assert.equal(applyAction(fresh,send).accepted,false);
  s = tap(s,'back'); s = tap(s,'contact:mom'); assert.equal(applyAction(s,{...send,id:'late'}).accepted,false);
});
test('drafts, notes and alarms survive navigation; unrelated notification does not invalidate a send', () => {
  let s = start(); s = tap(s,'app:messages'); s = tap(s,'contact:mom'); s = type(s,'reply','5:40 PM');
  s = tap(s,'home'); s = tap(s,'app:clock'); s = type(s,'alarm','08:15'); s = tap(s,'save-alarm');
  s = tap(s,'home'); s = tap(s,'app:messages'); s = tap(s,'contact:mom'); assert.equal(s.drafts.mom,'5:40 PM'); assert.deepEqual(s.alarms,['08:15']);
  const before = observe(s); s = advance(s,7000);
  const result = applyAction(s,{roundId:s.roundId,id:'final',type:'tap',target:'send',screen:before.screen}); assert.equal(result.state.phase,'finished');
});
test('recorded actions reproduce the exact phone outcome and scheduled interruptions', () => {
  let s = advance(start(),14000); s = reply(s,'The appointment finishes at 17:40.');
  assert.deepEqual(replay(makeReplay(s)),s);
  assert.throws(()=>replay({...makeReplay(s),version:'other'}),/version/);
});
test('unseen variation needs its own appointment time', () => {
  let s = tap(createPhone({roundId:'variation',scenario:SCENARIOS[1]}),'start');
  s = reply(s,'5:40 PM'); assert.equal(s.phase,'playing');
  s = type(s,'reply','3:15 PM'); s = tap(s,'send'); assert.equal(s.phase,'finished');
});
test('model action parsing fails closed and personalization actually enters the request', () => {
  const o = observe(start()); assert.throws(()=>parseDecision('{"type":"tap","target":"win"}',o),/unavailable/);
  const action = parseDecision('{"type":"tap","target":"app:calendar"}',o); assert.equal(action.target,'app:calendar');
  const current = observe(tap(tap(createPhone({roundId:'prompt-variation',scenario:SCENARIOS[1]}),'start'),'app:calendar'));
  const prompt = actionPrompt({observation:current,profile:{objective:'imitate',examples:[{
    observation:{screen:{app:'calendar'},text:['Dentist ends at 5:40 PM']},action:{type:'tap',target:'home'},
  }, { observation:{screen:{app:'messages',contact:'mom'},text:['Unrelated old conversation']},
    action:{type:'type',target:'reply',value:'5:40 PM'},
  }]}});
  assert.match(prompt,/Imitate/); assert.match(prompt,/Dentist ends at 5:40 PM/);
  assert.doesNotMatch(prompt,/Unrelated old conversation/);
  assert.ok(prompt.indexOf('Dentist ends at 5:40 PM') < prompt.indexOf('Visible information:'));
  assert.match(prompt,/3:15 PM/);
});

test('draining waits for active inference and refuses new work before unloading weights', async () => {
  const local = new LocalController(); let finish, closed = false;
  local.session = { modelId: 'loaded-candidate', generate: () => new Promise(resolve => { finish = resolve; }), close: async () => { closed = true; } };
  const generation = local.generate({kind:'reply',message:'When?',context:'5:40 PM'});
  const closing = local.close();
  assert.equal(closed,false);
  await assert.rejects(local.generate({kind:'reply',message:'Another?',context:'Later'}),/busy/);
  finish({outputText:'5:40 PM'}); const result = await generation; await closing;
  assert.equal(result.model, 'loaded-candidate'); assert.equal(result.execution.modelId, result.model);
  assert.equal(closed,true); assert.equal(local.session,null);
});

test('local and distributed controllers use the same explicit sampling policy', async () => {
  const policy = JSON.parse(await readFile(new URL('../mesh-policy.json', import.meta.url)));
  const local = new LocalController(); let options;
  local.session = { modelId: 'sampling-fixture', generate: async (_messages, actual) => {
    options = actual; return { outputText: '3:15 PM' };
  } };
  await local.generate({ kind: 'reply', message: 'When?', context: '3:15 PM' });
  for (const key of ['temperature', 'topK', 'topP', 'repetitionPenalty',
    'repetitionPenaltyWindow', 'presencePenalty', 'useChatTemplate']) {
    assert.equal(options[key], policy.model.generation[key], key);
  }
});
