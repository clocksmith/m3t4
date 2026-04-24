# Audio

Audio assets only.

This directory owns:

- sfx prompts and stage music prompts
- the single-file sfx sprite layout and its manifest
- audio post-process directives (trimming, seam verification, normalization, encoding)
- text-to-audio art direction that keeps audio on-theme

This directory must not own:

- gameplay rules, scoring, or anything that affects match outcome
- HUD text, fighter names, or voice lines (those live in `content/`)
- runtime selection such as which stage music is active (that lives in `config/`)
- visual assets or image-generation prompts (those live in `theming/`)

## SSOT

`audio/audio-theme.v1.json` holds every prompt and every post-process
directive. Edit it; do not hand-edit the generated prompt files or the
promoted audio assets under `client/assets/audio/`.

## Buckets

- `sfx` — short combat and UI cues. All sfx concat into a single
  `assets/audio/sfx/sprite.webm` plus a `sprite.manifest.json` of
  `{ id: [startMs, endMs] }` regions. One fetch, one decode, zero
  per-trigger latency.
- `stageMusicPacks` — per-stage ambient loops. Each stage variant gets
  its own seamless opus file. Loop seams are verified by the
  post-processor; failing seams are rejected, not crossfaded.

## Trigger contract

Sfx fire on state-edge transitions in the interpolated frame stream
(see `integrationNotes.triggerMap` in the SSOT). The stream-driven
design means:

- The trigger layer must suppress edges on the first frame after
  `primePlayback()` — otherwise a buffered backlog blasts every past
  event at once when joining mid-match.
- Edges on `hp` changes drive the hit cue, not `swipeT` — a swing
  that misses should be silent.

## Runtime toggle

Audio is opt-in. `localStorage['m3t4:audio:on']` defaults to `false`;
browsers block autoplay anyway. The toggle lives in the Live sidebar
and gates a single master `GainNode`, so flipping it on/off is instant
and does not tear down the audio graph.

## Workflow

1. Edit `audio/audio-theme.v1.json`.
2. `node tools/build-audio-prompts.mjs` expands the SSOT into 21
   paste-ready prompts under `audio/generated-prompts/<timestamp>-launch-audio-files/`
   (15 sfx batches + 3 stage music + 3 impact IRs).
3. Generate raw `.wav` output into `generations/raw/audio/…` at the
   paths printed at the top of each prompt file (gitignored).
4. `node tools/postprocess-audio.mjs <path>` processes one raw wav;
   `node tools/postprocess-audio.mjs --all` processes every raw wav
   that exists and assembles the sprite. Requires `ffmpeg` + `ffprobe`
   on PATH (macOS: `brew install ffmpeg`).

The post-processor:
- slices batch wavs on 700ms+ silence regions (below -55 dBFS),
  trims each cue, pads, loudness-normalizes to -14 LUFS, and
  concatenates everything into `client/assets/audio/sfx/sprite.webm`
  with a `sprite.manifest.json` of [startMs, endMs] per cue;
- verifies stage music loop seams (rejects if head/tail RMS diverges
  >1 dB — does not silently crossfade);
- unit-normalizes impact-IR energy so `wetSendDb` is the only runtime
  loudness knob.

Runtime is wired in `client/lib/audio.js` + `client/modes/spectate.js`.
Missing assets degrade silently — the toggle still flips, cues are
just no-ops until the sprite and stage files land under `client/assets/audio/`.
