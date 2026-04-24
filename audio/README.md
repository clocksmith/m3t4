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

## Workflow (planned)

1. Edit `audio/audio-theme.v1.json`.
2. `node tools/build-audio-prompts.mjs` expands the SSOT into
   paste-ready per-entry prompts under `audio/generated-prompts/`.
3. Generate raw `.wav` output into `generations/raw/audio/...`
   (gitignored, mirrors the image pipeline convention).
4. `node tools/postprocess-audio.mjs` trims, normalizes, verifies loop
   seams, concats the sfx sprite, and promotes the final assets under
   `client/assets/audio/`.

Neither tool exists yet. The SSOT is the contract they will be built
against.
