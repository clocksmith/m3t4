import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeaponMotionWire,readWeaponMatch} from '../lib/weapon-motion-wire.js';
const send=message=>JSON.parse(JSON.stringify(message));
test('old peers pin legacy motion; capable peers advertise and pin the next match without changing an existing one',()=>{
  const host=createWeaponMotionWire(),guest=createWeaponMotionWire();
  const first=readWeaponMatch(send(host.match({seed:17,stageId:'datacenter'})));
  assert.equal(first.weaponMotionVersion,0);
  host.receiveCosmetic(send(guest.cosmetic({side:1,body:'elon',weapon:'orbit_lance'})));
  assert.equal(host.peerVersion,1);
  assert.equal(first.weaponMotionVersion,0,'capability arrival cannot mutate the running match');
  const second=readWeaponMatch(send(host.match({seed:18,stageId:'datacenter'})));
  assert.equal(second.weaponMotionVersion,1);
  host.receiveCosmetic(send({type:'cosmetic',side:1,body:'sama',weapon:'worldcoin_orb_flail'}));
  assert.equal(host.peerVersion,0,'unversioned old peer stays compatible');
  assert.equal(host.match({seed:19},1).weaponMotionVersion,0,'caller cannot force an unsupported version');
});
test('new guest mirrors an old host and refuses unsupported explicit motion versions',()=>{
  const oldHost=readWeaponMatch(send({type:'match',seed:9,stageId:'datacenter'}));
  assert.equal(oldHost.weaponMotionVersion,0);
  assert.equal(readWeaponMatch(send({type:'match',seed:10,weaponMotionVersion:99})),null,'cannot silently simulate a future host with legacy physics');
});
