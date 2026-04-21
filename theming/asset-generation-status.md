# Asset Generation Status

Tracks generated assets that are good enough to ship, need another pass, or are still missing.

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
| `assets/chars/darrius/legal_department_midnight/row-strips/rows-03-05.png` | regenerate later | Current strip can ship, but the latest prompt copy should produce cleaner fall/wall/dive containment. |
