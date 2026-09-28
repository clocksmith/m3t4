import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionOwner } from '../decision.mjs';
import { createPhone, applyAction, advance } from '../engine.mjs';
const tap=(s,target)=>applyAction(s,{roundId:s.roundId,id:crypto.randomUUID(),type:'tap',target}).state;
const start=()=>tap(createPhone({roundId:'r'}),'start');
const context={matchId:'match',controllerId:'agent'};
const result=p=>({binding:p.binding,text:'{"type":"tap","target":"app:calendar"}'});
test('cancelled provider output cannot mutate a rematch or a new controller owner',()=>{
 const owner=createDecisionOwner(),state=start(),pending=owner.begin(state,context);
 owner.cancel();assert.equal(pending.signal.aborted,true);
 assert.equal(owner.accept(state,result(pending),context).accepted,false);
 const next=owner.begin(state,{...context,controllerId:'new-agent'});
 assert.equal(owner.accept(state,result(pending),{...context,controllerId:'new-agent'}).accepted,false);
 assert.equal(owner.accept(state,result(next),{...context,controllerId:'new-agent'}).accepted,true);
});
test('a changed draft or intervening navigation retires the observation even on the same screen',()=>{
 const owner=createDecisionOwner(),state=start(),pending=owner.begin(state,context);
 const changed=tap(tap(state,'app:clock'),'home');
 assert.deepEqual(changed.screen,state.screen);
 assert.equal(owner.accept(changed,result(pending),context).accepted,false);
});
test('notification arrival permits a still-valid decision; result is applied at most once',()=>{
 let time=10;const owner=createDecisionOwner({now:()=>time}),state=start(),pending=owner.begin(state,context);
 time=25;const applied=owner.accept(advance(state,7000),result(pending),context);
 assert.equal(applied.accepted,true);assert.equal(owner.receipts[0].timeToValidActionMs,15);
 assert.equal(owner.accept(applied.state,result(pending),context).accepted,false);
});
test('finished/expired round rejects delayed output',()=>{
 const owner=createDecisionOwner(),state=start(),pending=owner.begin(state,context);
 assert.equal(owner.accept(advance(state,180000),result(pending),context).accepted,false);
});
