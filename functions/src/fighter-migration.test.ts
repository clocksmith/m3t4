import assert from 'node:assert/strict';
import test from 'node:test';
import {BEHAVIOR_VERSION} from '@m3t4/sim';
import {normalizeStableTotals,publicStableDoc,type StableDoc} from './stable-public.js';
import {publicBotDoc,publicBotId} from './public-bots.js';

test('every persisted seat gets current shared AI metadata and matching public names without leaking config',()=>{
 const stable:StableDoc={userId:'old-player',handle:'unchanged',lastActiveAt:0,createdAt:10,updatedAt:11,slots:Array.from({length:7},(_,i)=>({slotId:`id-${i}`,slotIdx:i,name:`old-${i}`,config:{privateStrategy:true},elo:1200+i,wins:i,losses:2,draws:3,lastPlayedAt:0,submittedAt:4}))};
 const before=structuredClone(stable), next=normalizeStableTotals(stable);
 assert.deepEqual(stable,before);
 const publicSlots=(publicStableDoc(next).slots as Record<string,unknown>[]);
 assert.equal(publicSlots.length,7);
 for(let i=0;i<7;i++){
  const slot=next.slots[i], bot=publicBotDoc(next,slot)!;
  assert.equal(slot.aiBehaviorVersion,BEHAVIOR_VERSION);
  assert.equal(slot.fighterNameVersion,1);
  assert.deepEqual(slot.previousNames,[before.slots[i].name]);
  assert.equal(slot.config,stable.slots[i].config);
  assert.equal(bot.botId,publicBotId(stable.userId,stable.slots[i]));
  assert.equal(bot.name,slot.name); assert.equal(publicSlots[i].name,slot.name);
  assert.equal('config' in bot,false);assert.equal('previousNames' in bot,false);assert.equal('config' in publicSlots[i],false);
 }
 const second=normalizeStableTotals(next);
 assert.deepEqual(second,next);
 assert.equal(second.slots,next.slots);
});
