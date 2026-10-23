# Duel roster visual correction, 2026-10-23

Status: partial correction, local only. No push, deployment, Firestore changes,
or Doe changes. Source checkout `/Users/xyz/deco/m3t4` is Mars (`mac.lan`),
on main at `0fafffa`. Its dirty `client/render/canvas2d.js` and
`client/render/index.js` HUD edits were preserved. Work is in an isolated local
clone on main under the task workspace; no source checkout files were modified.

## Implemented and checked

- All 24 weapon IDs explicitly select a weapon-type body timeline. Clubs,
  mauls, blades, pikes, axes, flails and nunchucks have different anticipation,
  strike and recovery pose thresholds. This changes body pose timing only.
- Primary hands now cover the calibrated atlas grip rather than a point three
  pixels up the blade. Long/heavy weapons receive an axial support grip and
  short visible handle extension; support coordinates follow the attack angle
  and mirror across the fighter origin.
- Arm overlays use character sleeve/skin colors for all six fighters, including
  Jensen and Elon, which previously inherited Sama's skin color.
- KO sprites no longer retain a weapon floating at the standing combat origin.
- Existing native body scales, per-frame ground origins, source-facing repairs,
  atlas crop rectangles, and calibrated weapon endpoints were inspected and
  retained. None of the combat shapes or simulation constants changed.

Focused command (18 passing tests):

```
node --test client/test/weapon-motion.test.mjs client/test/fighter-art.test.mjs client/test/weapon-assets.test.mjs client/test/portrait-cells.test.mjs
```

Browser evidence uses `node tools/roster-art-review.mjs OUTPUT_DIRECTORY`.
Headless Chromium at CSS widths 1440 and 390 renders every fighter, all 24
weapons, idle plus four attack samples, both facings, and wall-slide/dive/KO.
Screenshots use the real Canvas2D renderer and local atlases, with cloud
requests blocked. Reports assert no horizontal layout overflow or page errors.
These are local canvas checks, not physical-device or production qualification.

## Visual findings still requiring correction

The roster is **not yet uniform**, and this change does not claim otherwise.
All six body and portrait sheets and all six weapon atlases were visually read.

| Fighter | Body path beneath `client/assets/chars/` | Remaining visual work |
| --- | --- | --- |
| sama | `sama/monastic_infra/sprite.png` | Use as tall silhouette/pixel-density reference. Idle arms hang down while live weapon is forward. Author armed dominant-hand poses matching grip; preserve navy shirt, narrow silhouette, small head. |
| darrius | `darrius/legal_department_midnight/sprite.png` | Keep curls/glasses and warm jacket accents. Standardize outline/shadow ramp with Sama. Author gripping rather than open-palm swing cells and a thrust anticipation/recovery row. |
| demis | `demis/chalk_and_static/sprite.png` | Keep bald head, blue glasses and suit. Remove baked white slash from swing cells 1–3, then author clean grip poses. Current metadata avoids those cells, reducing available attack poses. |
| mark | `mark/wellness_berserker/sprite.png` | Keep athletic silhouette and sleeveless outfit. Match outline/palette density, repair varying pose styles in later rows. Author separate nunchuck/flail wrist/chain poses and two-handed club poses. |
| jensen | `jensen/silicon_sovereign/sprite.png` | Replace large-head/short-leg rendering with Sama-scale adult proportions, sparse three-tone pixel shading, hard one-pixel outlines. Keep silver hair, glasses and leather jacket. Current portrait sheet is also much smoother than first four. |
| elon | `elon/orbital_showman/sprite.png` | Same proportion/pixel-density correction as Jensen. Preserve dark swept hair and jacket. Current smooth chibi portrait sheet must match the other four's crisp bust portrait treatment. |

Each corresponding `portraits/sheet.png` needs the same shared palette/outline
rules while preserving identity and three facial-expression cells plus the
full-body cell. Portrait layout is 192x192, four 96x96 cells. Body atlas contract:
384x768 RGBA, six columns of 64x64, twelve rows; row counts
4/6/2/2/2/2/6/3/4/2/4/4. Unused cells transparent, standing foot baseline at
cell y62–63, total standing silhouette about 56px; no separators or baked effects.

Weapon atlases: `client/assets/weapons/{sama,darrius,demis,mark,jensen,elon}/sheet.png`.
All are 96x96, four 48px cells. Keep current per-cell axes in
`client/render/fighter-art.js`; never replace them with catalog's old generic
grip values. Palette/style should be shared, but retain distinct item shapes.

The body sheets bake complete arms. Procedural bridge/support hands cannot
remove those original arms, so some poses still visibly have a spare hand or
an implausible elbow. Proper resolution requires armed body cells or separable
arm layers with per-frame shoulder/elbow/wrist sockets, not larger bridges.

Pikes still sweep upward, and flail/nunchuck chains are still rigid atlas art.
`client/sim/combat-geometry.js::swordSeg` defines one always-extended 52px segment
with one 0.12s upward attack arc for every weapon. The new type-specific body
timing does not turn this into a physically correct thrust or articulated flail.
Changing collision paths/reach/active windows is a separate deterministic combat
contract change; moving only visual endpoints would make hit detection lie.
No such mechanics change was made in this art task.

## Image generation attempt

Built-in image generation was available and used with Jensen as edit target
and Sama as style reference. Requested the exact body atlas contract above,
adult 56px proportions, 8–10px head, hard pixel outlines and no weapons/trails.
Output: task workspace `generated_images/exec-ff9f57a6-82ce-4694-93c4-a66670491472.png`.
Actual output is 887x1774 and retains the oversized-head style. It was visually
rejected and not installed or resampled. No ad hoc raster edits were used.
This was a completed generation with an unacceptable result, not a denied or
pending tool action. Exact source paths and changes needed are listed above.

## Task artifacts

Relative to the task workspace (parent of this clone):

- `artifacts/before/roster-1440.png`, `artifacts/before/roster-390.png`
- `artifacts/after/roster-1440.png`, `artifacts/after/roster-390.png`
- Each image directory has matching JSON reports.
- `artifacts/focused-tests.txt` is the focused test transcript.

Publication status: unpublished. Bitmap redesign and true weapon-specific
combat arcs remain unresolved. No approval action is pending.
