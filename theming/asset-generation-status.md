# Asset Generation Status

Tracks generated assets that are good enough to ship, need another pass, or are still missing.

## Current Runtime Usage

All three stage packs are present under `client/assets/` and loaded by the
Canvas2D renderer.

Renderer usage:

| Asset class | Runtime use |
|---|---|
| Stage `sky.png` | Drawn once at full arena size, `1280x720`. |
| Stage `far_parallax.png`, `mid_parallax.png`, `near_parallax.png` | Horizontally tiled over the full arena, with integer-snapped scroll offsets. |
| Stage `platform.png` | Tiled onto every platform. Solid floor uses the top `min(36px, platform height)`; one-way platforms use their full `14-16px` height. |
| Stage `platform_edge.png` | Tiled over platform tops, up to `16px` high. |
| Stage `wall.png` | Tiled only inside solid floor bodies below the top edge. |
| Stage `floor_detail.png` | Drawn once, centered on wide solid floors only. |
| Character `sprite.png` | `64x64` cells rendered at `1.25x` (`80x80` visual cell). Sim hitbox remains `26x52`; visible body target is roughly `35x65` after render scaling. |
| Weapon `launch.png` | `48x48` cells rendered at about `0.96x` idle and `1.12x` active. |
| Objective payload | Source `48x48`, rendered `34x34` in-world. |
| Objective target | Source `96x96`, rendered `96x96`, anchored so the intake ring matches the sim goal point. |

## Scale And Style Audit

Missing-file checks are not enough anymore. The current art pass should also
audit:

- Character/background proportion on all three stages. Current sprites may read
  small or too clean against dense backgrounds.
- Whether `SPRITE_RENDER_SCALE = 1.25` should stay, increase slightly, or be
  replaced by higher-resolution character cells.
- Whether stage parallax layers are too detailed compared with 64px character
  sheets.
- Whether platform textures read as traversable surfaces at gameplay scale.
- Whether future prompts should move from strict early-SNES toward late-SNES /
  arcade side-scroller polish while keeping sprite-sheet constraints and a
  16-bit feel.

Regeneration priority should be based on screenshots from real gameplay
framing, not only isolated prompt outputs.

## Generation Source Scale

The prompt SSOT now requires every raw generation target to be an exact
`1x`, `2x`, or `3x` multiple of the promoted runtime PNG. `tools/build-prompts.mjs`
fails if a prompt would use a fractional ratio or a larger downscale.

Current rule of thumb:

| Asset class | Source scale |
|---|---:|
| Full stage skies and parallax strips | `1x` |
| Stage preview thumbs | `2x` |
| Character row strips | `3x` |
| Portrait sheets and large portraits | `3x` |
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
| 026 | `assets/stages/demoday/demo_day_afterparty/textures/floor_detail.png` | `26.png` | good | Floor debris/decal strip. |

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
| 017 | `assets/stages/boardroom/fiduciary_basement/textures/floor_detail.png` | good | Existing import is usable. |

## Character Watchlist

| Asset | Status | Notes |
|---|---|---|
| `assets/chars/sama/monastic_infra/sprite.png` | audit scale | Check against all three rendered stage packs; may need higher-detail late-16-bit/arcade regen or a runtime scale adjustment. |
| `assets/chars/darrius/legal_department_midnight/sprite.png` | audit scale | Check against all three rendered stage packs; hair/glasses should remain readable after any scale/style pass. |
| `assets/chars/darrius/legal_department_midnight/row-strips/rows-03-05.png` | regenerate later | Current strip can ship, but the latest prompt copy should produce cleaner fall/wall/dive containment. |
