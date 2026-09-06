# Render Contract

This file documents the presentation/runtime bridge. It is intentionally outside `theming/` because it describes integration obligations, not visual asset data.

## Boundaries

- `theming/visual-theme.v1.json`: visual assets only: palettes, sprites, textures, particles, VFX, and generation prompts.
- `content/game-copy.v1.json`: copy and fiction only: names, labels, HUD strings, voice lines, objective nouns.
- `config/presentation-selection.v1.json`: selected IDs only.
- `data/preset-ranking.v1.json`: generated balance/build data, not theme.
- `client/styles/tokens.css`: UI chrome and fallback canvas tokens. Cyan navigation/objectives, blue/violet fighters, red danger, and semantic surfaces.
- `plasma-lab` compute work: advisory sidecar work only. It must not block
  render, own the frame budget, mutate ranked state, or consume private render
  buffers unless a later Plasma derived-compute contract explicitly declares
  public/redacted regions and receipt bindings.

## Notes

Fields the renderer must consume across the split manifests. Visual data,
copy, and selected IDs are intentionally separate so theming cannot grow into
game rules or product configuration.

## UI Visual Language

`client/app.css` composes tokens, primitives, shared components, and mode layouts. Paint lives in `client/styles/tokens.css`; shared controls and page chrome live in `client/styles/components/`. The shared HTML helpers live in `client/ui/`, and Workshop/Roster use the same `client/lib/slider-editor.js`. Inline styles are only for data-dependent artwork cells and meter fills, not alternate themes.

The fallback canvas renderer reads `--arena-*` tokens from `client/styles/tokens.css`. Authored art, stage palettes, sprites, and generated prompts still belong in `theming/`.

## Browser verification and asset delivery

Run `npx playwright install chromium`, then `npm run test:ui`. The smoke serves the actual client locally, blocks external services, and checks local fights, archive replay, route navigation, trait preservation, save handoff, and desktop/tablet/phone-width layouts. It checks all four sprite sheets at native 64×64 cells, including mirrored run/idle and wall-facing slides. Screenshots and a JSON report go to the printed temporary directory. This is headless browser evidence, not physical-device, signed-in, ranked, or P2P qualification.

Sprite sheets remain lossless PNG. Stage layers prefer existing WebP derivatives with PNG fallback, requested on first draw and reused afterward. Canvas backing resolution uses an integer logical scale sized to the display. Firebase Hosting revalidates code/config and bounds mutable artwork caching; it does not publish test fixtures or unused source packs. No immutable cache promise is made for unversioned asset names.

## Renderer Must Consume

- `config/presentation-selection.v1.json.selection.stages[stage]` selects `theming/visual-theme.v1.json.stageVisualPacks[stage][pack]`.
- `stageVisualPacks[stage][pack].palette` -> stage lighting / tint.
- `stageVisualPacks[stage][pack].layers.{sky,farParallax,midParallax,nearParallax}` -> parallax scroll draw.
- `stageVisualPacks[stage][pack].textures.{platform,platformEdge,wall,floorDetail}` -> platform/wall/floor draw.
- `stageVisualPacks[stage][pack].particles` -> particle pack id in `theming/visual-theme.v1.json.particlePacks`.
- `selection.characterGraphics[char] + characterGraphics[char][pack].spriteSheet` -> animated body draw.
- `selection.characterGraphics[char] + characterGraphics[char][pack].portraits.sheet` and portrait cells -> HUD + character select draw.
- `selection.characters[char] + characterVisualPacks[char][pack].colors` -> HP bar, damage numbers, UI accents.
- `selection.characters[char] + content/game-copy.v1.json.characters[char][pack]` -> name, label, archetype, voice lines.
- `selection.stages[stage] + content/game-copy.v1.json.stages[stage][pack]` -> stage display name and subtitle.
- `selection.weaponFamilies[char][tier] + weaponVisuals[char][weaponId].sprite` and `spriteCell` -> weapon layer on top of hand.
- `selection.weaponFamilies[char][tier] + weaponVisuals[char][weaponId].trail.{color,width,ttl}` -> swing-trail particle system.
- `selection.weaponFamilies[char][tier] + weaponVisuals[char][weaponId].hitVFX` -> particle burst on impact frame.
- `selection.weaponFamilies[char][tier] + content/game-copy.v1.json.weapons[char][weaponId]` -> weapon name and copy.
- `selection.goalSet + content/game-copy.v1.json.goalSets` -> stage goal labels and replay display labels.
- `content/game-copy.v1.json.stageGoalTargets[stage]` -> target names and metric labels per lane.
- `selection.deliveryProfile` combines `content/game-copy.v1.json.deliveryProfiles[id]` with `theming/visual-theme.v1.json.objectiveVisuals.deliveryProfiles[id]`.
- `selection.targetProfile` combines `content/game-copy.v1.json.targetProfiles[id]` with `theming/visual-theme.v1.json.objectiveVisuals.targetProfiles[id]`.
- `selection.hudTextPack + content/game-copy.v1.json.hudTextPacks` -> objective HUD copy.
- Weapon animation and hitbox assumptions stay in sim/render code. Do not encode gameplay timing in theming.

## Renderer-First Device Ownership

The renderer has first claim on the browser session. Compute can borrow
measured slack through the opt-in worker path, but the live spectator stream,
ranked playback, frame decode, and input responsiveness must not wait on
compute. A compute failure is never a render failure.

Do not claim "every game frame is a science frame" or fused-kernel/shared-buffer
compute until a Plasma derived-compute contract binds source frame hashes,
buffer-region hashes, producer kernels, lifetimes, and validation policy.

## Migration Notes

- Replace source goal labels in `sim/src/stage.ts` and generated `client/sim/stage.js` with the selected goal set only through a display-label resolver.
- Keep archived replay artifacts unchanged unless running an explicit replay migration; prefer display-label mapping for legacy records.
- Renderer integration must consume stage, objective, character, weapon, copy, and particle manifests through the split files above.
