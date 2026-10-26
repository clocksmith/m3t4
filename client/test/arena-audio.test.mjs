import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaAudioTracker } from '../lib/arena-audio.js';

const fighter = { x: 300, vx: 0, vy: 0, onGround: true, wall: 0, swipeT: 0, diveT: 0, stun: 0, dead: false, lastClashTick: -9999 };
const frame = changes => ({ p0: { ...fighter, ...changes }, p1: { ...fighter, x: 900 }, token: { exists: false, carrier: -1 }, scoreboard: [0, 0], rounds: [0, 0] });
function harness() {
  const calls = [];
  let enabled = true, now = 1000;
  const audio = { ready: true, isEnabled: () => enabled, play(cue, options) { calls.push({ cue, options }); return {}; } };
  const tracker = createArenaAudioTracker({ audioSource: () => audio, clock: () => now });
  return { calls, tracker, mute() { enabled = false; }, advance() { now += 200; } };
}

for (const [name, before, after, cue] of [
  ['swing', {}, { swipeT: 0.2 }, 'swipe_blade'],
  ['swing restart', { swipeT: 0.05 }, { swipeT: 0.2 }, 'swipe_blade'],
  ['jump', {}, { onGround: false, vy: -300 }, 'jump_boing'],
  ['wall jump', { onGround: false, wall: 1 }, { onGround: false, vy: -300 }, 'jump_boing'],
  ['landing', { onGround: false, vy: 300 }, {}, 'footstep_a'],
  ['running', {}, { x: 308, vx: 200 }, 'footstep_a'],
  ['hit', {}, { stun: 0.1 }, 'hit_darrius_alignment_baton'],
  ['knockout', {}, { dead: true }, 'ko_flatline'],
  ['clash', {}, { lastClashTick: 10 }, 'hit_sama_gpu_server_blade'],
]) test(`arena frames trigger ${name} audio`, () => {
  const h = harness(); h.tracker.update(frame(before)); h.tracker.update(frame(after));
  assert.ok(h.calls.some(c => c.cue === cue), JSON.stringify(h.calls));
});

test('held frames and reset previews do not replay old effects', () => {
  const h = harness(); const moving = frame({ vx: 200 });
  h.tracker.update(moving); h.advance(); h.tracker.update(moving);
  assert.deepEqual(h.calls, []);
  h.tracker.reset(); h.tracker.update(frame({ dead: true, swipeT: 0.2, lastClashTick: 20 }));
  assert.deepEqual(h.calls, []);
});

test('muted previews stay silent and score/objective changes produce cues', () => {
  const h = harness(); const first = frame({}); h.tracker.update(first);
  const scored = frame({}); scored.token = { exists: true, carrier: 0 }; scored.scoreboard = [1, 0]; scored.rounds = [1, 0];
  h.tracker.update(scored);
  assert.deepEqual(h.calls.map(c => c.cue), ['proof_spawn', 'proof_acquired', 'proof_delivered', 'round_taken']);
  h.calls.length = 0; h.mute(); h.tracker.update(frame({ swipeT: 0.2 }));
  assert.deepEqual(h.calls, []);
});
