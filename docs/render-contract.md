# Render Contract

This file documents the presentation/runtime bridge. It is intentionally outside `theming/` because it describes integration obligations, not visual asset data.

## Boundaries

- `theming/visual-theme.v1.json`: visual assets only: palettes, sprites, textures, particles, VFX, and generation prompts.
- `content/game-copy.v1.json`: copy and fiction only: names, labels, HUD strings, voice lines, objective nouns.
- `config/presentation-selection.v1.json`: selected IDs only.
- `data/preset-ranking.v1.json`: generated balance/build data, not theme.
- `client/app.css :root`: UI chrome and fallback canvas tokens only: black/red/blue/purple primitives, semantic UI colors, and temporary arena fallback colors.

## Notes

Fields the renderer must consume across the split manifests. Visual data,
copy, and selected IDs are intentionally separate so theming cannot grow into
game rules or product configuration.

## UI Visual Language

`client/app.css` is the single source of truth for app chrome colors and reusable UI classes. Mode templates should not use inline `style` attributes or hardcoded hex values. Use semantic classes such as `panel`, `row`, `toolbar`, `metric-value`, `code-export`, and the CSS variables declared in `:root`.

The fallback canvas renderer may read `--arena-*` tokens from `client/app.css` until the full manifest resolver consumes `theming/visual-theme.v1.json`. Authored art, stage palettes, sprites, and generated prompts still belong in `theming/`.

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

## Migration Notes

- Replace source goal labels in `sim/src/stage.ts` and generated `client/sim/stage.js` with the selected goal set only through a display-label resolver.
- Keep archived replay artifacts unchanged unless running an explicit replay migration; prefer display-label mapping for legacy records.
- Renderer integration must consume stage, objective, character, weapon, copy, and particle manifests through the split files above.
