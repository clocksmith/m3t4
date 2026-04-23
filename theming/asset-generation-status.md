# Asset Generation Status

Tracks generated assets that are good enough to ship, need another pass, or are still missing.

## Current Runtime Usage

All three stage packs are present under `client/assets/` and loaded by the
Canvas2D renderer.

Renderer usage:

| Asset class | Runtime use |
|---|---|
| Stage `sky.png` | Drawn once at full arena size, `1280x720`. |
| Stage `far_parallax.png`, `mid_parallax.png`, `near_parallax.png` | Horizontally tiled over the full arena as atmospheric drift layers; built-in transparent pixels define the reveal. |
| Stage `platform.png` | Tiled onto every platform. Solid floor uses the top `min(36px, platform height)`; one-way platforms use their full `14-16px` height. |
| Stage `platform_edge.png` | Tiled over platform tops, up to `16px` high. |
| Stage `wall.png` | Tiled inside solid floor bodies below the top edge and into the left/right arena boundary gutters. |
| Character `sprite.png` | `64x64` cells rendered unscaled. Sim hitbox is `28x56`; visible body target is roughly `28x56` inside the cell. |
| Weapon `sheet.png` | 2x2 grid of `48x48` cells, one sheet per character, rendered at about `0.96x` idle and `1.12x` active. |
| Objective payload | Source `48x48`, rendered `34x34` in-world. |
| Objective target | Source `96x96`, rendered `96x96`, anchored so the intake ring matches the sim goal point. |

## Scale And Style Audit

Missing-file checks are not enough anymore. The current art pass should also
audit:

- Character/background proportion on all three stages. Current sprites should
  read as unscaled `64x64` cells with a roughly `28x56` body.
- Whether `28x56` is the right default hitbox/body target before any full
  character regen.
- Whether stage parallax layers are too detailed compared with 64px character
  sheets.
- Whether platform textures read as traversable surfaces at gameplay scale.
- Whether future prompts should move from strict early-SNES toward late-SNES /
  arcade side-scroller polish while keeping sprite-sheet constraints and a
  16-bit feel.

Regeneration priority should be based on screenshots from real gameplay
framing, not only isolated prompt outputs.

## Runtime Scale Contract

Stage prompts now receive a shared scale contract from
`theming/visual-theme.v1.json`: arena `1280x720`, fighters rendered from
unscaled `64x64` cells, readable body and hitbox about `28x56`. Stage props,
platforms, doors, monitors, furniture, racks, rails, wall panels, podiums,
crowd elements, and debris should be proportioned so a `56px`-tall fighter
reads human-sized in the scene.

Each stage asset also receives a depth contract:

| Stage asset | Depth role |
|---|---|
| `sky.png` | Deepest atmosphere/architecture; no close gameplay-scale props. |
| `far_parallax.png` | Distant, lower-contrast background cues. |
| `mid_parallax.png` | Background props behind platforms and fighters. |
| `near_parallax.png` | Nearest backdrop dressing, still behind the combat plane. |
| `platform.png` / `platform_edge.png` | Actual walkable gameplay surface at fighter scale. |
| `wall.png` | Solid floor/body fill and side-boundary gutter texture, close to gameplay but not a prop layer. |

## Weapon Placement Audit

Current character sheets do not contain skeleton weapon guides or drawn
weapons. That is intentional: weapons render as a separate layer. Current
placement is still approximate, though: the renderer computes one generic hand
point from fighter position, facing, `bodyW`, and `bodyH`, then rotates the
weapon sprite toward the sim sword tip. There is no per-weapon vertical offset
hack; generated weapons should be centered around their declared grip point.

Better next pass:

- Keep character sheets empty-hand.
- Add per-animation/per-frame hand-anchor metadata, not visible skeleton pixels.
- Drive the weapon layer from those anchors so idle, run, carry, dive, and swing
  frames attach to the actual hand pose.
- Add a debug overlay that draws hand anchor, weapon base, and weapon tip over
  gameplay screenshots before regenerating weapon art.

## Generation Source Scale

The prompt SSOT now requires every raw generation target to be an exact
`1x`, `2x`, or `3x` multiple of the promoted runtime PNG. `tools/build-prompts.mjs`
fails if a prompt would use a fractional ratio or a larger downscale.

Current rule of thumb:

| Asset class | Source scale |
|---|---:|
| Full stage skies and parallax strips | `1x` |
| Stage preview thumbs | `2x` |
| Packed character sheets | `3x` |
| Combined portrait/full-body sheets | `3x` |
| Stage tiles, objective sprites, weapon sheets, locked-slot UI | `3x` |

## Demo Day Afterparty

Source folder: `~/Downloads/demoday`

| Prompt | Asset | Source | Status | Notes |
|---:|---|---|---|---|
| 018 | `assets/stages/demoday/demo_day_afterparty/ui/preview_thumb.png` | `18.png` | good | Preview/full scene. |
| 019 | `assets/stages/demoday/demo_day_afterparty/layers/sky.png` | `19.png` | good | Sky/backdrop. Not swapped with 018. |
| 020 | `assets/stages/demoday/demo_day_afterparty/layers/far_parallax.png` | `20.png` | good | Far scaffolding/depth layer. |
| 021 | `assets/stages/demoday/demo_day_afterparty/layers/mid_parallax.png` | `21.png` | good | Mid banners/glitch strip layer. |
| 022 | `assets/stages/demoday/demo_day_afterparty/layers/near_parallax.png` | `22.png` | good | Near rigging/podium layer. |
| 023 | `assets/stages/demoday/demo_day_afterparty/textures/platform.png` | `new_23.png` | watch | Better than `23_old.png`; use in-game, regenerate only if it reads too wall-like. |
| 024 | `assets/stages/demoday/demo_day_afterparty/textures/platform_edge.png` | `24.png` | watch | Source aspect was not 16:1, but center-cropped into a usable thin edge strip. |
| 025 | `assets/stages/demoday/demo_day_afterparty/textures/wall.png` | `25.png` | good | Wall tile. |

## Boardroom Fiduciary Basement

| Prompt | Asset | Status | Notes |
|---:|---|---|---|
| 009 | `assets/stages/boardroom/fiduciary_basement/ui/preview_thumb.png` | good | Existing import is usable. |
| 010 | `assets/stages/boardroom/fiduciary_basement/layers/sky.png` | good | Existing import is usable. |
| 011 | `assets/stages/boardroom/fiduciary_basement/layers/far_parallax.png` | good | Existing import is usable. |
| 012 | `assets/stages/boardroom/fiduciary_basement/layers/mid_parallax.png` | regenerate | Prompt was tightened after oversized/medieval prop issues. |
| 013 | `assets/stages/boardroom/fiduciary_basement/layers/near_parallax.png` | regenerate | Old prompt produced giant/medieval objects; regenerate from latest prompt folder. |
| 014 | `assets/stages/boardroom/fiduciary_basement/textures/platform.png` | watch | Usable, but re-check after 012/013 are replaced. |
| 015 | `assets/stages/boardroom/fiduciary_basement/textures/platform_edge.png` | watch | Usable, but re-check after 012/013 are replaced. |
| 016 | `assets/stages/boardroom/fiduciary_basement/textures/wall.png` | good | Existing import is usable. |

## Character Watchlist

| Asset | Status | Notes |
|---|---|---|
| `assets/chars/sama/monastic_infra/sprite.png` | audit scale | Check against all three rendered stage packs; may need higher-detail late-16-bit/arcade regen or a runtime scale adjustment. |
| `assets/chars/darrius/legal_department_midnight/sprite.png` | audit scale | Check against all three rendered stage packs; hair/glasses should remain readable after any scale/style pass. |
| `assets/chars/demis/chalk_and_static/sprite.png` | regenerate | Promoted into the full playable prompt batch; generate packed sheets before enabling the body in roster selection. |
| `assets/chars/mark/wellness_berserker/sprite.png` | regenerate | Promoted into the full playable prompt batch; generate packed sheets before enabling the body in roster selection. |
| `assets/chars/darrius/legal_department_midnight/packed/pack-01.png` | regenerate later | Current body can ship, but the latest prompt copy should produce cleaner wall/dive/swing containment. |
