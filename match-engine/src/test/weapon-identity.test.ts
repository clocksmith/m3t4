import test from 'node:test';
import assert from 'node:assert/strict';
import {STRATEGIES,STAGES,verifyActionLog} from '@m3t4/sim';
import {runMatch} from '../match-runner.js';
test('new matches persist selected weapon motion and replay the same combat result',()=>{
  const stable={userId:'local-a',handle:'a',slotId:'a0',slotName:'a',config:STRATEGIES.blitz,elo:1000,isHuman:false,lastPlayedAt:0};
  const input={matchId:'weapon-review-fixture',startedAt:1729,pair:{
    a:{...stable,cosmetics:{body:'elon',weapon:'orbit_lance'}},
    b:{...stable,userId:'local-b',handle:'b',slotId:'b0',config:STRATEGIES.shipper,cosmetics:{body:'sama',weapon:'worldcoin_orb_flail'}},
  }};
  const {match}=runMatch(input);
  assert.deepEqual(match.chars.map(c=>c.weaponMotionVersion),[1,1]);
  assert.deepEqual(new Set(match.chars.map(c=>c.weapon)),new Set(['orbit_lance','worldcoin_orb_flail']));
  const replay=verifyActionLog({stage:STAGES.datacenter,seed:match.seed,chars:match.chars,actionLog:Uint8Array.from(Buffer.from(match.actionLog,'base64')),expectedLogHash:match.actionLogHash,expectedResult:match.result});
  assert.equal(replay.ok,true,replay.reason);
});
