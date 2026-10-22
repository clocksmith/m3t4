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

Run `npx playwright install chromium`, then `npm run test:ui`. The smoke serves the actual client locally, blocks external services, and checks local fights, archive replay, route navigation, trait preservation, save handoff, and desktop/tablet/phone-width layouts. It checks all registered sprite sheets at native 64×64 cells, including mirrored run/idle and wall-facing slides. Screenshots and a JSON report go to the printed temporary directory. This is headless browser evidence, not physical-device, signed-in, ranked, or P2P qualification.

Sprite sheets remain lossless PNG. Live stage scenery is code-native in `client/render/stage-art.js`: three cached vector layers per stage, bounded deterministic parallax, atmospheric depth, and reduced-motion support. Legacy WebP/PNG stage assets are retained as archival art, not loaded by the live renderer. Canvas backing resolution uses an integer logical scale sized to the display. Firebase Hosting revalidates code/config and bounds mutable artwork caching; it does not publish test fixtures or unused source packs. No immutable cache promise is made for unversioned asset names.

## Presentation bridge and current owners

- Stage selection chooses the stage identity and copy pack. The active renderer dispatches that identity to `stage-art.js`.
- Archived stage palettes remain design references; code-native lighting is authored alongside each cached scene.
- Legacy `stageVisualPacks` layers/textures describe archived raster source assets. Live geometry and palette ownership is `client/render/stage-art.js`; it never changes simulation platform rectangles.
- Particle/effect descriptors are not a universal runtime sprite-sheet registry; current combat effects are code-native.
- `selection.characterGraphics[char] + characterGraphics[char][pack].spriteSheet` -> animated body draw.
- `selection.characterGraphics[char] + characterGraphics[char][pack].portraits.sheet` and portrait cells -> HUD + character select draw.
- `selection.characters[char] + characterVisualPacks[char][pack].colors` -> HP bar, damage numbers, UI accents.
- `selection.characters[char] + content/game-copy.v1.json.characters[char][pack]` -> name, label, archetype, voice lines.
- `selection.stages[stage] + content/game-copy.v1.json.stages[stage][pack]` -> stage display name and subtitle.
- `selection.weaponFamilies[char][tier] + weaponVisuals[char][weaponId].sprite` and `spriteCell` -> weapon layer on top of hand.
- `weaponVisuals` trail descriptions are design metadata. Runtime trails and timing are driven by the simulation-frame renderer.
- Hit effects currently use code-native rendering, not universal `hitVFX` bitmap sheets.
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

## Fighter/weapon acceptance

Bodies are 384×768 RGBA PNG, 6×12 cells of 64×64, 41 distinct populated poses in the manifest order. Portraits are 192×192, 2×2 cells of 96×96: neutral, hurt, KO, full body. Weapons are 96×96, 2×2 cells of 48×48: common, rare, epic, legendary. They are four separate rigid items, not four animation frames. All tiers use identical combat timing, reach, hurtboxes and stat budgets; existing Elo gates still apply.

Jensen and Elon are stylized fictional parody archetypes, with no claimed affiliation or endorsement. Generation is only a draft step. Oversized/shifted generation outputs require explicit reviewed crop/packing receipts before integration, not silent cell clipping. Final acceptance checks actual alpha bounds, all 41 distinct poses, mirrored facings, grounded/air origins, opaque weapon grip/tip endpoints, silhouette reach limits and actual browser playback. The renderer never changes gameplay geometry to fit art.

`theming/characters.ts` and `theming/weapons.ts` are authoring type contracts, not loaded by the browser. Live bodies are registered in `canvas2d.js`, portraits in `character-presentation.js`, inventory in the mirrored roster catalog, and pivots in `fighter-art.js`. Keep these narrow integrations synchronized; do not infer a universal asset loader.
