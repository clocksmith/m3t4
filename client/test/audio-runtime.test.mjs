import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let instance = 0;
async function audioHarness(t, { storedOn = true, holdStage = null } = {}) {
  const window = new Window();
  const saved = new Map(['window', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const starts = [];
  let context;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  class AudioContext extends window.EventTarget {
    constructor() { super(); context = this; this.currentTime = 0; this.state = 'suspended'; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async decodeAudioData(bytes) { return { url: new TextDecoder().decode(bytes) }; }
    createGain() {
      return { connect() {}, gain: { value: 1, setTargetAtTime() {}, linearRampToValueAtTime() {} } };
    }
    createConvolver() { return { connect() {} }; }
    createBufferSource() {
      const source = { connect() {}, stop() {}, playbackRate: { value: 1 }, start(...args) { starts.push({ source, args }); } };
      return source;
    }
  }
  window.AudioContext = AudioContext;
  if (storedOn) window.localStorage.setItem('m3t4:audio:on', 'on');
  globalThis.window = window;
  globalThis.localStorage = window.localStorage;
  globalThis.fetch = async url => {
    if (holdStage && url.includes(`/stages/${holdStage}/`)) await held;
    return {
      ok: true,
      async arrayBuffer() { return new TextEncoder().encode(url).buffer; },
      async json() { return { swipe_blade: [100, 300] }; },
    };
  };
  t.after(async () => {
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const { getAudio } = await import(`../lib/audio.js?runtime-test=${++instance}`);
  return { audio: getAudio(), starts, window, release, get context() { return context; } };
}

test('remembered audio loads effects and resumes on the first interaction after reload', async t => {
  const h = await audioHarness(t);
  await h.audio.setStage('datacenter');
  assert.equal(h.audio.ready, false);
  assert.equal(h.context, undefined);
  h.window.dispatchEvent(new h.window.Event('pointerdown'));
  assert.equal(h.context.state, 'running');
  await h.audio.setStage('datacenter');
  assert.equal(h.audio.ready, true);
  const source = h.audio.play('swipe_blade');
  assert.ok(source);
  assert.equal(h.starts.at(-1).source.buffer.url, '/assets/audio/sfx/sprite.webm');
  assert.deepEqual(h.starts.at(-1).args, [0, 0.1, 0.2]);
});

test('a slow previous stage cannot replace the latest selected music', async t => {
  const h = await audioHarness(t, { holdStage: 'datacenter' });
  h.audio.setEnabled(true);
  const old = h.audio.setStage('datacenter');
  await h.audio.setStage('boardroom');
  h.release();
  await old;
  const music = h.starts.filter(({ source }) => source.loop);
  assert.equal(music.length, 1);
  assert.match(music[0].source.buffer.url, /boardroom/);
});

test('leaving the page cancels music that is still downloading', async t => {
  const h = await audioHarness(t, { holdStage: 'datacenter' });
  h.audio.setEnabled(true);
  const pending = h.audio.setStage('datacenter');
  h.audio.stopMusic();
  h.release();
  await pending;
  assert.equal(h.starts.filter(({ source }) => source.loop).length, 0);
  h.audio.setEnabled(false);
  assert.equal(h.audio.play('swipe_blade'), null);
});

test('a subsequent click resumes an interrupted mobile context', async t => {
  const h = await audioHarness(t);
  h.audio.setEnabled(true); await h.audio.setStage('datacenter');
  h.context.state = 'interrupted';
  h.window.dispatchEvent(new h.window.Event('click'));
  assert.equal(h.context.state, 'running');
});
