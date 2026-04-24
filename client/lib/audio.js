// Runtime audio graph for the Live page.
//
// - One sprite.webm decoded into a single AudioBuffer; cues played via
//   AudioBufferSourceNode.start(when, offsetSec, durationSec), offsets
//   looked up from sprite.manifest.json.
// - Per-stage music loop (AudioBufferSourceNode loop=true) with 1.5s
//   crossfade on stage change.
// - Per-stage impact ConvolverNode on a wet send; only hit_* cues route
//   through it. All other cues go to the dry master.
// - Master GainNode gated by localStorage['m3t4:audio:on'] (default off).
//   AudioContext is lazy-initialized on first toggle-on (browsers require
//   a user gesture).
// - Defensive: asset fetch failures degrade silently. If sprite.webm is
//   missing the toggle still flips on; cues are just no-ops.

const SPRITE_URL = "/assets/audio/sfx/sprite.webm";
const MANIFEST_URL = "/assets/audio/sfx/sprite.manifest.json";
const MUSIC_URL = (stage, variant) => `/assets/audio/stages/${stage}/${variant}/music.webm`;
const IR_URL = (stage, variant) => `/assets/audio/stages/${stage}/${variant}/impact_ir.webm`;
const CROSSFADE_S = 1.5;
const ENABLED_KEY = "m3t4:audio:on";

const STAGE_VARIANT = {
  datacenter: "cold_aisle_chapel",
  boardroom: "fiduciary_basement",
  demoday: "demo_day_afterparty",
};
const STAGE_WET_DB = {
  datacenter: -9.0,
  boardroom: -12.0,
  demoday: -10.5,
};

let singleton = null;

export function getAudio() {
  if (!singleton) singleton = create();
  return singleton;
}

export function audioEnabledStored() {
  try { return localStorage.getItem(ENABLED_KEY) === "on"; } catch { return false; }
}

function create() {
  let ctx = null;
  let master = null;
  let dry = null;
  let wet = null;              // ConvolverNode input gain (wet send)
  let wetOut = null;           // convolver output gain (stage-specific wetSendDb)
  let convolver = null;
  let sprite = null;           // AudioBuffer
  let manifest = null;         // { id: [startMs, endMs] }
  let musicCache = new Map();  // "stage/variant" -> AudioBuffer
  let irCache = new Map();
  let currentMusic = null;     // { source, gain, key }
  let currentStage = null;
  let enabled = audioEnabledStored();
  let bootPromise = null;
  const loopSources = new Map();

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 1 : 0;
    master.connect(ctx.destination);
    dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);
    wet = ctx.createGain();
    wet.gain.value = 1;
    wetOut = ctx.createGain();
    wetOut.gain.value = 0;       // no stage yet
    convolver = ctx.createConvolver();
    wet.connect(convolver);
    convolver.connect(wetOut);
    wetOut.connect(master);
    return ctx;
  }

  async function boot() {
    if (!ensureContext()) return;
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const [spriteBuf, manifestJson] = await Promise.all([
        fetchBuffer(SPRITE_URL, ctx),
        fetchJson(MANIFEST_URL),
      ]);
      if (spriteBuf) sprite = spriteBuf;
      if (manifestJson) manifest = manifestJson;
    })().catch(() => {});
    return bootPromise;
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off"); } catch {}
    if (!enabled) {
      if (master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      return;
    }
    ensureContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    master.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
    boot();
    if (currentStage) setStage(currentStage);
  }

  function isEnabled() { return enabled; }

  async function setStage(stage) {
    currentStage = stage;
    if (!enabled || !ensureContext()) return;
    const variant = STAGE_VARIANT[stage];
    if (!variant) return;
    const key = `${stage}/${variant}`;
    const [musicBuf, irBuf] = await Promise.all([
      cacheGet(musicCache, key, () => fetchBuffer(MUSIC_URL(stage, variant), ctx)),
      cacheGet(irCache, key, () => fetchBuffer(IR_URL(stage, variant), ctx)),
    ]);
    if (irBuf) {
      convolver.buffer = irBuf;
      const wetDb = STAGE_WET_DB[stage] ?? -10;
      wetOut.gain.setTargetAtTime(dbToGain(wetDb), ctx.currentTime, 0.1);
    } else {
      wetOut.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    }
    if (musicBuf) swapMusic(musicBuf, key);
  }

  function swapMusic(buffer, key) {
    if (currentMusic && currentMusic.key === key) return;
    const now = ctx.currentTime;
    const nextGain = ctx.createGain();
    nextGain.gain.value = 0;
    nextGain.connect(master);
    const next = ctx.createBufferSource();
    next.buffer = buffer;
    next.loop = true;
    next.connect(nextGain);
    next.start();
    nextGain.gain.linearRampToValueAtTime(0.6, now + CROSSFADE_S);
    if (currentMusic) {
      const { source, gain } = currentMusic;
      gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
      try { source.stop(now + CROSSFADE_S + 0.05); } catch {}
    }
    currentMusic = { source: next, gain: nextGain, key };
  }

  function stopMusic() {
    if (!currentMusic || !ctx) return;
    const now = ctx.currentTime;
    const { source, gain } = currentMusic;
    gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
    try { source.stop(now + CROSSFADE_S + 0.05); } catch {}
    currentMusic = null;
  }

  function play(cueId, { when = 0, impact = false } = {}) {
    if (!enabled || !sprite || !manifest) return null;
    const span = manifest[cueId];
    if (!span) return null;
    const [startMs, endMs] = span;
    const offset = startMs / 1000;
    const duration = (endMs - startMs) / 1000;
    const src = ctx.createBufferSource();
    src.buffer = sprite;
    const gain = ctx.createGain();
    src.connect(gain);
    const routeImpact = impact || cueId.startsWith("hit_");
    if (routeImpact) gain.connect(dry), gain.connect(wet);
    else gain.connect(dry);
    const t = ctx.currentTime + Math.max(0, when);
    try { src.start(t, offset, duration); } catch { return null; }
    return src;
  }

  function startLoop(cueId, key = cueId, gainDb = -20) {
    if (!enabled || !sprite || !manifest) return;
    if (loopSources.has(key)) return;
    const span = manifest[cueId];
    if (!span) return;
    const [startMs, endMs] = span;
    const offset = startMs / 1000;
    const dur = (endMs - startMs) / 1000;
    const src = ctx.createBufferSource();
    src.buffer = sprite;
    src.loopStart = offset;
    src.loopEnd = offset + dur;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(gainDb);
    src.connect(gain);
    gain.connect(dry);
    src.start(ctx.currentTime, offset);
    loopSources.set(key, { src, gain });
  }

  function stopLoop(key) {
    const entry = loopSources.get(key);
    if (!entry) return;
    const now = ctx.currentTime;
    entry.gain.gain.linearRampToValueAtTime(0, now + 0.1);
    try { entry.src.stop(now + 0.15); } catch {}
    loopSources.delete(key);
  }

  return {
    setEnabled, isEnabled, setStage, play, startLoop, stopLoop, stopMusic,
    get ready() { return !!(sprite && manifest); },
  };
}

async function fetchBuffer(url, ctx) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  } catch { return null; }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function cacheGet(cache, key, loader) {
  if (cache.has(key)) return cache.get(key);
  const v = await loader();
  if (v) cache.set(key, v);
  return v;
}

function dbToGain(db) { return Math.pow(10, db / 20); }
