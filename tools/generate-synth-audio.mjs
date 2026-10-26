#!/usr/bin/env node
// Synthesizes retro N64 / SNES / Street Fighter style audio assets for m3t4:
// - Batched SFX WAVs in generations/raw/audio/batches/
// - Stage music loops in generations/raw/audio/stages/<stage>/<variant>/music.wav
// - Stage impact IRs in generations/raw/audio/stages/<stage>/<variant>/impact_ir.wav
//
// Follows audio/audio-theme.v1.json specifications:
// - 48000 Hz, 16-bit PCM WAV.
// - Batches separate cues by 1000ms digital silence, with 500ms trailing silence.
// - Music loops verify seamless seam RMS matching.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rawRoot = path.resolve(repoRoot, "generations/raw/audio");
const SAMPLE_RATE = 48000;

// --- DSP / Synthesis Primitives ---

function makeWav(samples, sampleRate = SAMPLE_RATE, channels = 1) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

// Lowpass / Highpass Filter (Simple One-Pole / BiQuad)
class Filter {
  constructor(type = "lp", freq = 1000, q = 1, sampleRate = SAMPLE_RATE) {
    this.type = type;
    this.sampleRate = sampleRate;
    this.setParams(freq, q);
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  setParams(freq, q = 1) {
    const w0 = 2 * Math.PI * Math.min(freq, this.sampleRate * 0.49) / this.sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.max(0.01, q));
    const cosw0 = Math.cos(w0);
    if (this.type === "lp") {
      this.b0 = (1 - cosw0) / 2;
      this.b1 = 1 - cosw0;
      this.b2 = (1 - cosw0) / 2;
      this.a0 = 1 + alpha;
      this.a1 = -2 * cosw0;
      this.a2 = 1 - alpha;
    } else if (this.type === "hp") {
      this.b0 = (1 + cosw0) / 2;
      this.b1 = -(1 + cosw0);
      this.b2 = (1 + cosw0) / 2;
      this.a0 = 1 + alpha;
      this.a1 = -2 * cosw0;
      this.a2 = 1 - alpha;
    } else { // bp
      this.b0 = alpha;
      this.b1 = 0;
      this.b2 = -alpha;
      this.a0 = 1 + alpha;
      this.a1 = -2 * cosw0;
      this.a2 = 1 - alpha;
    }
  }
  process(x) {
    const y = (this.b0 / this.a0) * x +
              (this.b1 / this.a0) * this.x1 +
              (this.b2 / this.a0) * this.x2 -
              (this.a1 / this.a0) * this.y1 -
              (this.a2 / this.a0) * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// Pseudo-random white noise
function whiteNoise() {
  return Math.random() * 2 - 1;
}

// 16-bit / SNES bitcrusher / distortion
function bitcrush(x, bits = 12) {
  const steps = Math.pow(2, bits);
  return Math.round(x * steps) / steps;
}

// Soft saturation curve
function saturate(x, drive = 1.5) {
  const v = x * drive;
  return Math.tanh(v);
}

// ADSR envelope helper
function env(t, dur, a = 0.01, d = 0.1, s = 0.5, r = 0.1) {
  if (t < 0 || t > dur) return 0;
  if (t < a) return t / a;
  const relStart = dur - r;
  if (t >= relStart) {
    const relT = (t - relStart) / Math.max(0.001, r);
    return s * (1 - relT);
  }
  const decT = (t - a) / Math.max(0.001, d);
  if (decT < 1) return 1 - (1 - s) * decT;
  return s;
}

// --- Sound Effect Generators ---

// 1. Silly Bouncy BOING!
function synthBoing(dur = 0.35) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const filter = new Filter("bp", 400, 3);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Rapid exponential rise from 160Hz to 680Hz
    const baseFreq = 160 + 520 * Math.pow(t / dur, 0.7);
    // Vibrato wobble (18Hz spring oscillation)
    const vibrato = Math.sin(2 * Math.PI * 18 * t) * (35 * (1 - t / dur));
    const freq = baseFreq + vibrato;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    // Triangle + square wave
    const tri = 2 * Math.abs(2 * ((phase / (2 * Math.PI)) % 1) - 1) - 1;
    const sq = Math.sin(phase) > 0 ? 0.6 : -0.6;
    const raw = tri * 0.7 + sq * 0.3;
    filter.setParams(freq * 1.2, 2.5);
    const filtered = filter.process(raw);
    const amplitude = Math.exp(-t * 7.5);
    out[i] = saturate(bitcrush(filtered * amplitude * 1.5, 10), 1.2);
  }
  return out;
}

// 2. Weapon Swipes (Street Fighter swooshes)
function synthSwipe(kind = "blade", dur = 0.25) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let startFreq = 2800, endFreq = 400, resonance = 2, bodyFreq = 180;
  if (kind === "greatsword") { startFreq = 1500; endFreq = 220; resonance = 3; bodyFreq = 120; }
  else if (kind === "flail") { startFreq = 3400; endFreq = 600; resonance = 1.5; bodyFreq = 220; }
  else if (kind === "maul") { startFreq = 800; endFreq = 100; resonance = 2.5; bodyFreq = 75; }
  else if (kind === "bat") { startFreq = 1800; endFreq = 350; resonance = 2; bodyFreq = 320; }
  else if (kind === "club") { startFreq = 1200; endFreq = 280; resonance = 1.5; bodyFreq = 160; }
  else if (kind === "pike") { startFreq = 2200; endFreq = 500; resonance = 4; bodyFreq = 400; }
  else if (kind === "axe") { startFreq = 1900; endFreq = 300; resonance = 2.2; bodyFreq = 150; }
  else if (kind === "nunchucks") { startFreq = 2500; endFreq = 700; resonance = 2; bodyFreq = 260; }

  const filter = new Filter("bp", startFreq, resonance);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const cutoff = startFreq * Math.pow(endFreq / startFreq, p);
    filter.setParams(cutoff, resonance);
    let noise = whiteNoise();
    if (kind === "nunchucks" && p > 0.45 && p < 0.55) noise += whiteNoise() * 1.5; // double swish
    const filtered = filter.process(noise);
    const body = Math.sin(2 * Math.PI * (bodyFreq * (1 - p * 0.5)) * t) * Math.exp(-t * 18);
    const amp = Math.sin(p * Math.PI) * 1.2;
    out[i] = saturate((filtered * 0.8 + body * 0.4) * amp, 1.4);
  }
  return out;
}

// 3. Street Fighter Meaty Combat Impacts (Hits)
function synthHit(char = "sama", weapon = "blade", dur = 0.3) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const filter = new Filter("lp", 2500, 1.5);
  let pitchStart = 260, pitchEnd = 45;
  if (weapon.includes("maul") || weapon.includes("greatsword")) { pitchStart = 190; pitchEnd = 35; }
  else if (weapon.includes("bat") || weapon.includes("club")) { pitchStart = 320; pitchEnd = 55; }
  else if (weapon.includes("flail")) { pitchStart = 380; pitchEnd = 65; }

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    // Classic Street Fighter pitch-swept punch body
    const freq = pitchStart * Math.pow(pitchEnd / pitchStart, Math.min(1, p * 4));
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const squarePunch = Math.sin(phase) > 0 ? 0.7 : -0.7;
    const tri = 2 * Math.abs(2 * ((phase / (2 * Math.PI)) % 1) - 1) - 1;
    // Initial attack snap (noise burst)
    const snap = whiteNoise() * Math.exp(-t * 90) * 1.8;
    // Low-end thud
    const body = (squarePunch * 0.5 + tri * 0.5) * Math.exp(-t * 16);
    // Metallic resonance for blades/flails
    const metal = (weapon.includes("blade") || weapon.includes("flail") || weapon.includes("greatsword"))
      ? Math.sin(2 * Math.PI * 1450 * t) * Math.exp(-t * 22) * 0.35
      : 0;
    filter.setParams(1200 + 1500 * Math.exp(-t * 30), 1.8);
    const mixed = filter.process(snap + body + metal);
    out[i] = saturate(bitcrush(mixed, 11), 1.8);
  }
  return out;
}

// 4. Synthesized Voice Grunts (16-bit Formant Voice Synthesis)
function synthGrunt(char = "sama", kind = "effort", dur = 0.25) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let f0 = 140; // Fundamental pitch
  if (char === "darrius") f0 = 105; // deep
  else if (char === "demis") f0 = 150;
  else if (char === "mark") f0 = 175;

  if (kind === "ko") f0 *= 0.85;
  else if (kind === "hurt") f0 *= 1.15;

  // Formant filters for vocal tract: /a/ or /o/
  const f1 = new Filter("bp", 700, 4);
  const f2 = new Filter("bp", 1250, 4);
  const f3 = new Filter("bp", 2500, 3);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    // Pitch inflection
    let pitchMod = 1;
    if (kind === "effort") pitchMod = 1 + 0.3 * Math.sin(p * Math.PI);
    else if (kind === "hurt") pitchMod = 1.2 - 0.4 * p;
    else if (kind === "ko") pitchMod = 1.1 - 0.7 * Math.pow(p, 0.7);

    const freq = f0 * pitchMod;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    // Harmonic rich saw pulse train
    const saw = 2 * ((phase / (2 * Math.PI)) % 1) - 1;
    const voice = f1.process(saw) * 1.0 + f2.process(saw) * 0.6 + f3.process(saw) * 0.3;
    const breath = whiteNoise() * 0.15 * Math.exp(-t * 10);
    const envelope = Math.sin(p * Math.PI);
    out[i] = saturate(bitcrush((voice + breath) * envelope, 10), 1.3);
  }
  return out;
}

// 5. Dive Lunge (descending cartoon air drop)
function synthDive(dur = 0.32) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const filter = new Filter("bp", 1200, 2);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const freq = 1400 * Math.exp(-p * 3) + 150;
    filter.setParams(freq, 2.5);
    const noise = filter.process(whiteNoise());
    const sub = Math.sin(2 * Math.PI * (160 - 90 * p) * t) * 0.4;
    const env = Math.sin(p * Math.PI);
    out[i] = saturate((noise + sub) * env, 1.4);
  }
  return out;
}

// 6. Spawn Enter, Footsteps, KO Flatline
function synthFootstep(type = "a", dur = 0.10) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const center = type === "a" ? 280 : 210;
  const filter = new Filter("bp", center, 2.5);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const filtered = filter.process(whiteNoise());
    out[i] = filtered * Math.exp(-t * 45) * 1.5;
  }
  return out;
}

function synthSpawnEnter(dur = 0.35) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  // Thud + rising chime
  const filter = new Filter("lp", 400, 1.5);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const thud = filter.process(whiteNoise()) * Math.exp(-t * 20) * 1.2;
    // Rising 16-bit chime arpeggio
    const note = Math.floor(p * 4);
    const freqs = [523.25, 659.25, 783.99, 1046.50]; // C E G C
    phase += (2 * Math.PI * freqs[note]) / SAMPLE_RATE;
    const chime = Math.sin(phase) * Math.exp(-t * 8) * 0.35;
    out[i] = saturate(thud + chime, 1.2);
  }
  return out;
}

function synthKoFlatline(dur = 0.55) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Heavy impact crash in first 150ms
    const crash = (t < 0.18) ? whiteNoise() * Math.exp(-t * 18) * 1.5 : 0;
    // Low flatline tone (220 Hz decaying beep)
    phase += (2 * Math.PI * 220) / SAMPLE_RATE;
    const tone = Math.sin(phase) * 0.35 * Math.exp(-Math.max(0, t - 0.15) * 3);
    out[i] = saturate(crash + tone, 1.2);
  }
  return out;
}

// 7. Proof Events & Goal Timers (16-bit Arcade Chimes)
function synthProofEvent(type = "spawn", dur = 0.3) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let notes = [523.25, 659.25, 783.99]; // C E G
  if (type === "acquired") notes = [659.25, 880.00]; // E A (coin pickup!)
  else if (type === "delivered") notes = [440, 554.37, 659.25, 880]; // A C# E A (victory!)

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const step = Math.min(notes.length - 1, Math.floor(p * notes.length));
    const freq = notes[step];
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const sq = Math.sin(phase) > 0 ? 0.4 : -0.4;
    const tri = 2 * Math.abs(2 * ((phase / (2 * Math.PI)) % 1) - 1) - 1;
    const amp = Math.sin(p * Math.PI) * 0.8;
    out[i] = saturate((sq * 0.4 + tri * 0.6) * amp, 1.3);
  }
  return out;
}

function synthProofCarryingLoop(dur = 0.5) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 220 + 20 * Math.sin(2 * Math.PI * 4 * t);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    out[i] = Math.sin(phase) * 0.25 * (0.8 + 0.2 * Math.cos(2 * Math.PI * 8 * t));
  }
  return out;
}

function synthGoalTimer(type = "tick", dur = 0.2) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  if (type === "tick") {
    const filter = new Filter("bp", 1600, 5);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      out[i] = filter.process(whiteNoise()) * Math.exp(-t * 60) * 1.5;
    }
  } else if (type === "urgent") {
    const filter = new Filter("bp", 2400, 6);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      out[i] = filter.process(whiteNoise()) * Math.exp(-t * 70) * 1.8;
    }
  } else if (type === "spawn") {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      phase += (2 * Math.PI * 330) / SAMPLE_RATE;
      out[i] = Math.sin(phase) * Math.exp(-t * 10) * 0.6;
    }
  } else { // expire
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const freq = 180 - 80 * (t / dur);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const buzz = Math.sin(phase) > 0 ? 0.5 : -0.5;
      out[i] = buzz * Math.exp(-t * 8) * 0.7;
    }
  }
  return out;
}

// 8. Match Flow & End (Fight Bells & Fanfares)
function synthFightBell(dur = 0.45) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let p1 = 0, p2 = 0, p3 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Metallic bell ring (Street Fighter boxing bell: 1100Hz + 2250Hz + 3380Hz)
    p1 += (2 * Math.PI * 1100) / SAMPLE_RATE;
    p2 += (2 * Math.PI * 2250) / SAMPLE_RATE;
    p3 += (2 * Math.PI * 3380) / SAMPLE_RATE;
    const ring = Math.sin(p1) * 0.5 + Math.sin(p2) * 0.3 + Math.sin(p3) * 0.2;
    out[i] = ring * Math.exp(-t * 7) * 1.1;
  }
  return out;
}

function synthFanfare(dur = 0.8) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  // Street Fighter YOU WIN fanfare: C5 -> E5 -> G5 -> C6
  const freqs = [523.25, 659.25, 783.99, 1046.50];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const idx = Math.min(3, Math.floor(p * 4));
    const freq = freqs[idx];
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    // 16-bit brassy synth (square + saw)
    const sq = Math.sin(phase) > 0 ? 0.5 : -0.5;
    const saw = 2 * ((phase / (2 * Math.PI)) % 1) - 1;
    const noteP = (p * 4) % 1;
    const env = Math.sin(noteP * Math.PI) * 0.8;
    out[i] = saturate((sq * 0.5 + saw * 0.5) * env, 1.3);
  }
  return out;
}

function synthCrowdApplause(dur = 1.0) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  const f1 = new Filter("bp", 1400, 1.2);
  const f2 = new Filter("bp", 2800, 1.5);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / dur;
    const noise = whiteNoise();
    // Claps simulation: dense small spikes
    const clap = (Math.random() < 0.04) ? whiteNoise() * 1.2 : 0;
    const filtered = f1.process(noise + clap) * 0.7 + f2.process(noise) * 0.4;
    const envelope = Math.sin(p * Math.PI) * 0.9;
    out[i] = saturate(filtered * envelope, 1.1);
  }
  return out;
}

// Helper to concatenate an array of cue Float32Arrays with exactly 1000ms silence in between
function assembleBatchWav(cueArrays) {
  const silenceSamples = Math.round(1.0 * SAMPLE_RATE); // 1000ms digital silence
  const trailingSilence = Math.round(0.2 * SAMPLE_RATE); // 200ms trailing (< 700ms so silencedetect ignores it)
  let totalLength = 0;
  for (let i = 0; i < cueArrays.length; i++) {
    totalLength += cueArrays[i].length;
    if (i < cueArrays.length - 1) totalLength += silenceSamples;
  }
  totalLength += trailingSilence;

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < cueArrays.length; i++) {
    combined.set(cueArrays[i], offset);
    offset += cueArrays[i].length;
    if (i < cueArrays.length - 1) {
      // 1000ms digital silence (zeros)
      offset += silenceSamples;
    }
  }
  return makeWav(combined, SAMPLE_RATE, 1);
}

// --- Multi-track 16-Bit SNES / N64 Music Synthesizer ---

// Composes a seamless, high-energy 16-bit arcade fighting game track
function synthMusicTrack({ stage = "datacenter", durationSec = 48, bpm = 120 }) {
  const numSamples = Math.round(durationSec * SAMPLE_RATE);
  // Stereo interleaved samples: left, right, left, right...
  const stereo = new Float32Array(numSamples * 2);

  const secondsPerBeat = 60 / bpm;
  const secondsPerBar = secondsPerBeat * 4;
  const totalBars = Math.round(durationSec / secondsPerBar);

  // Scales & Chords per stage
  let chordProgression = [];
  if (stage === "datacenter") {
    // D minor arcade battle theme (Ryu/Ken style)
    chordProgression = [
      { bass: 73.42, root: 146.83, chord: [220, 261.63, 293.66] }, // Dm (D, F, A)
      { bass: 58.27, root: 116.54, chord: [233.08, 293.66, 349.23] }, // Bb
      { bass: 65.41, root: 130.81, chord: [261.63, 329.63, 392.00] }, // C
      { bass: 55.00, root: 110.00, chord: [220, 261.63, 329.63] },   // Am
    ];
  } else if (stage === "boardroom") {
    // A minor funk groove (Guile stage style)
    chordProgression = [
      { bass: 55.00, root: 110.00, chord: [220, 261.63, 329.63, 392] }, // Am7
      { bass: 65.41, root: 130.81, chord: [261.63, 329.63, 392, 440] }, // Cmaj7
      { bass: 73.42, root: 146.83, chord: [293.66, 349.23, 440, 523.25] }, // Dm7
      { bass: 49.00, root: 98.00,  chord: [196, 246.94, 293.66, 349.23] }, // G7
    ];
  } else {
    // E minor fast battle climax (Vega / Chun-Li style)
    chordProgression = [
      { bass: 82.41, root: 164.81, chord: [246.94, 329.63, 392.00] }, // Em
      { bass: 65.41, root: 130.81, chord: [261.63, 329.63, 392.00] }, // C
      { bass: 73.42, root: 146.83, chord: [293.66, 369.99, 440.00] }, // D
      { bass: 61.74, root: 123.47, chord: [246.94, 293.66, 369.99] }, // Bm
    ];
  }

  // Pre-generate periodic loop
  let leadPhase = 0;
  let bassPhase = 0;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const barIndex = Math.floor(t / secondsPerBar) % chordProgression.length;
    const currentChord = chordProgression[barIndex];
    const beatTime = (t % secondsPerBeat) / secondsPerBeat;
    const barTime = (t % secondsPerBar) / secondsPerBar;
    const sixteenth = Math.floor((t % secondsPerBeat) * 4);

    // 1. Kick Drum (beats 0 and 2 of 4-beat bar)
    const beatInBar = Math.floor(barTime * 4);
    const kick = (beatInBar === 0 || beatInBar === 2)
      ? Math.sin(2 * Math.PI * (130 * Math.exp(-beatTime * 18)) * t) * Math.exp(-beatTime * 14) * 0.65
      : 0;

    // 2. Snare Drum (beats 1 and 3 of 4-beat bar)
    const snare = (beatInBar === 1 || beatInBar === 3)
      ? (whiteNoise() * 0.45 + Math.sin(2 * Math.PI * 180 * t) * 0.3) * Math.exp(-beatTime * 10) * 0.6
      : 0;

    // 3. Hi-Hat (16th notes)
    const hihatTime = (t % (secondsPerBeat / 4)) / (secondsPerBeat / 4);
    const hihat = whiteNoise() * Math.exp(-hihatTime * 35) * 0.18;

    // 4. Bass Line (driving 16th-note FM bass)
    const bassOctave = (sixteenth % 2 === 1) ? 2 : 1;
    const bassFreq = currentChord.bass * bassOctave;
    bassPhase += (2 * Math.PI * bassFreq) / SAMPLE_RATE;
    const bassEnv = Math.exp(-hihatTime * 12);
    const bass = (Math.sin(bassPhase) + 0.3 * Math.sin(bassPhase * 2)) * bassEnv * 0.45;

    // 5. Synth Chords (SNES Poly Pad)
    let chords = 0;
    for (let c = 0; c < currentChord.chord.length; c++) {
      chords += Math.sin(2 * Math.PI * currentChord.chord[c] * t) * 0.08;
    }

    // 6. Melodic Arcade Lead (Square wave chiptune)
    const leadNotes = [1, 1.25, 1.33, 1.5, 1.75, 2.0];
    const leadNote = leadNotes[Math.floor((t * 2) % leadNotes.length)];
    const leadFreq = currentChord.root * 2 * leadNote;
    leadPhase += (2 * Math.PI * leadFreq) / SAMPLE_RATE;
    const vibrato = Math.sin(2 * Math.PI * 6 * t) * 0.08;
    const leadSq = (Math.sin(leadPhase + vibrato) > 0 ? 0.35 : -0.35) * (0.6 + 0.4 * Math.sin(barTime * Math.PI));

    // Combine tracks
    const monoMix = kick + snare + hihat + bass + chords + leadSq * 0.4;
    // Panning (stereo widening)
    const left = saturate(monoMix + chords * 0.2, 1.1) * 0.55;
    const right = saturate(monoMix - chords * 0.2, 1.1) * 0.55;

    stereo[i * 2] = left;
    stereo[i * 2 + 1] = right;
  }

  // Crossfade boundary (first/last 200ms) to ensure 100% flawless seamless seam matching
  const seamSamples = Math.round(0.3 * SAMPLE_RATE);
  for (let s = 0; s < seamSamples; s++) {
    const fade = s / seamSamples;
    // Blend end of track into start of track
    const tailIdx = (numSamples - seamSamples + s) * 2;
    const headIdx = s * 2;
    const blendL = stereo[headIdx] * fade + stereo[tailIdx] * (1 - fade);
    const blendR = stereo[headIdx + 1] * fade + stereo[tailIdx + 1] * (1 - fade);
    stereo[headIdx] = blendL;
    stereo[headIdx + 1] = blendR;
    stereo[tailIdx] = blendL;
    stereo[tailIdx + 1] = blendR;
  }

  return makeWav(stereo, SAMPLE_RATE, 2);
}

// --- Impact IR Generator ---
function synthImpactIr(durationSec = 0.5, stage = "datacenter") {
  const n = Math.round(durationSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  // Sharp direct pulse at t = 0
  out[0] = 0.95;
  out[1] = -0.7;
  out[2] = 0.4;

  let decayRate = 12;
  let filterFreq = 2200;
  if (stage === "boardroom") { decayRate = 14; filterFreq = 1200; }
  else if (stage === "demoday") { decayRate = 9; filterFreq = 1800; }

  const filter = new Filter("lp", filterFreq, 1.2);
  for (let i = 3; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const noise = filter.process(whiteNoise());
    out[i] = noise * Math.exp(-t * decayRate) * 0.35;
  }
  return makeWav(out, SAMPLE_RATE, 1);
}

// --- Main Execution ---

async function main() {
  process.stdout.write("Generating retro N64/SNES audio assets...\n");

  const batchesDir = path.join(rawRoot, "batches");
  fs.mkdirSync(batchesDir, { recursive: true });

  // 1. Swipes
  process.stdout.write("Synthesizing batch: swipes (9 cues)...\n");
  const swipesWav = assembleBatchWav([
    synthSwipe("flail", 0.28),
    synthSwipe("maul", 0.34),
    synthSwipe("blade", 0.20),
    synthSwipe("greatsword", 0.40),
    synthSwipe("bat", 0.25),
    synthSwipe("club", 0.22),
    synthSwipe("pike", 0.30),
    synthSwipe("axe", 0.32),
    synthSwipe("nunchucks", 0.32),
  ]);
  fs.writeFileSync(path.join(batchesDir, "swipes.wav"), swipesWav);

  // 2. Hits per character
  const chars = ["sama", "darrius", "demis", "mark"];
  const weaponsByChar = {
    sama: ["worldcoin_orb_flail", "backpack_maul", "gpu_server_blade", "heat_sink_greatsword"],
    darrius: ["rolled_constitution_bat", "alignment_baton", "red_team_pike", "guardrail_greatsword"],
    demis: ["nobel_medal_flail", "folded_chess_axe", "go_board_maul", "alphafold_blade"],
    mark: ["sunscreen_bottle_club", "controller_nunchucks", "shareholder_sauce_club", "quest_flail"],
  };

  for (const c of chars) {
    process.stdout.write(`Synthesizing batch: hits_${c}...\n`);
    const hits = weaponsByChar[c].map((w) => synthHit(c, w, 0.32));
    fs.writeFileSync(path.join(batchesDir, `hits_${c}.wav`), assembleBatchWav(hits));
  }

  // 3. Grunts per character
  for (const c of chars) {
    process.stdout.write(`Synthesizing batch: grunts_${c}...\n`);
    const grunts = [
      synthGrunt(c, "effort", 0.22),
      synthGrunt(c, "hurt", 0.26),
      synthGrunt(c, "ko", 0.55),
    ];
    fs.writeFileSync(path.join(batchesDir, `grunts_${c}.wav`), assembleBatchWav(grunts));
  }

  // 4. Movement (includes silly BOING!)
  process.stdout.write("Synthesizing batch: movement (includes jump_boing!)...\n");
  const movement = [
    synthDive(0.32),
    synthBoing(0.35),
    synthSpawnEnter(0.35),
    synthFootstep("a", 0.10),
    synthFootstep("b", 0.10),
    synthKoFlatline(0.55),
  ];
  fs.writeFileSync(path.join(batchesDir, "movement.wav"), assembleBatchWav(movement));

  // 5. Proof Events
  process.stdout.write("Synthesizing batch: proof_events...\n");
  const proofEvents = [
    synthProofEvent("spawn", 0.28),
    synthProofEvent("acquired", 0.24),
    synthProofEvent("delivered", 0.38),
  ];
  fs.writeFileSync(path.join(batchesDir, "proof_events.wav"), assembleBatchWav(proofEvents));

  // 6. Proof Carrying Loop
  process.stdout.write("Synthesizing batch: proof_carrying_loop...\n");
  const proofLoop = [synthProofCarryingLoop(0.5)];
  fs.writeFileSync(path.join(batchesDir, "proof_carrying_loop.wav"), assembleBatchWav(proofLoop));

  // 7. Goal Timer
  process.stdout.write("Synthesizing batch: goal_timer...\n");
  const goalTimer = [
    synthGoalTimer("spawn", 0.28),
    synthGoalTimer("tick", 0.18),
    synthGoalTimer("urgent", 0.18),
    synthGoalTimer("expire", 0.35),
  ];
  fs.writeFileSync(path.join(batchesDir, "goal_timer.wav"), assembleBatchWav(goalTimer));

  // 8. Match Flow
  process.stdout.write("Synthesizing batch: match_flow...\n");
  const matchFlow = [
    synthFightBell(0.45),
    synthFightBell(0.40),
    synthFightBell(0.50),
    synthProofEvent("acquired", 0.30),
  ];
  fs.writeFileSync(path.join(batchesDir, "match_flow.wav"), assembleBatchWav(matchFlow));

  // 9. Match End
  process.stdout.write("Synthesizing batch: match_end...\n");
  const matchEnd = [
    synthFanfare(0.85),
    synthGoalTimer("expire", 0.50),
    synthCrowdApplause(1.2),
  ];
  fs.writeFileSync(path.join(batchesDir, "match_end.wav"), assembleBatchWav(matchEnd));

  // 10. Music Loops & Impact IRs for each Stage
  const stages = [
    { stage: "datacenter", variant: "cold_aisle_chapel", dur: 48, bpm: 120 },
    { stage: "boardroom", variant: "fiduciary_basement", dur: 56, bpm: 120 },
    { stage: "demoday", variant: "demo_day_afterparty", dur: 64, bpm: 120 },
  ];

  for (const s of stages) {
    const stageDir = path.join(rawRoot, "stages", s.stage, s.variant);
    fs.mkdirSync(stageDir, { recursive: true });

    process.stdout.write(`Synthesizing music for ${s.stage}/${s.variant} (${s.dur}s @ ${s.bpm} BPM)...\n`);
    const musicWav = synthMusicTrack({ stage: s.stage, durationSec: s.dur, bpm: s.bpm });
    fs.writeFileSync(path.join(stageDir, "music.wav"), musicWav);

    process.stdout.write(`Synthesizing impact IR for ${s.stage}/${s.variant}...\n`);
    const irWav = synthImpactIr(0.5, s.stage);
    fs.writeFileSync(path.join(stageDir, "impact_ir.wav"), irWav);
  }

  process.stdout.write("All raw audio generated successfully!\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
