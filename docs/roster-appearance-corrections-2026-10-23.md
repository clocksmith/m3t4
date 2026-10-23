# Roster appearance follow-up

The user screenshot (`libfile_a87da953c95c81918b452aeebea4ea29`) was downloaded
through the supported Library helper into this task's executor, verified locally
as a readable 918x2048 PNG, and visually inspected. It shows the **home-page
portrait cards**, where Jensen and Elon have smaller/inset heads and a different
facial rendering style. It is not a screenshot of the battle sprite rig.

The equal-scale baseline reproduces that finding on source main `0e6f0cb`.
All home cards use the same outer viewport, but the portrait art has different
internal framing. The first substantial opaque crown row occupied these
fractions of the neutral portrait viewport:

| Fighter | Before | After |
| --- | ---: | ---: |
| sama | 5.2% | 5.2% |
| darrius | 6.3% | 6.5% |
| demis | 7.3% | 7.3% |
| mark | 1.0% | 1.0% |
| jensen | 13.9% | 4.7% |
| elon | 15.3% | 7.7% |

Hair volume remains character-specific; the correction aligns framing without
making every skull or hairstyle identical. Battle rigs retain their common
56px standing height and 10x12px head footprint.

## Changes

- Jensen's portrait sheet was redrawn against the actual Sama portrait sheet
  for pixel density, dark outline, flat shading and larger adult bust framing.
- Elon's rig head and portraits now read as older and less idealized: softer
  jaw, fuller cheeks, modest under-eye bags and subtle age lines. Dark swept
  hair, clothing and restrained identity remain; no exaggerated caricature.
- Darrius's rig and portraits now use very dark hair and a lighter neutral
  complexion, including neck and hands. The existing `darrius` ID is preserved.
- All five accepted PNGs are built-in imagegen edits of viewed references,
  copied byte-for-byte at 1254x1254 with alpha. There was no raster recoloring,
  resizing or compositing through Python or another image editor. Exact prompt
  history is in `roster-appearance-prompts-2026-10-23.json`.
- `portraitCellCrop` and `portraitSourceRect` align Jensen/Elon bust cells in
  Canvas; equivalent home CSS is checked against the shared crop in the browser.
  The crop is explicit source metadata, not a bitmap rewrite. Full-body cell 3
  keeps its full cell. Watch countdown portraits now derive 2x2 cell sizes from
  natural image dimensions instead of assuming a 192px sheet.
- Revised PNG URLs are versioned because Hosting caches images for one hour.
  This avoids showing the old faces after a future deployment. Hosting config
  was not changed.

No weapon assets, socket coordinates, bone lengths, animation timelines,
simulation source or browser simulation bundle changed. The rig loader only
received revised asset URLs. Original checkout edits were left untouched.

## Verification and artifacts

- 106 client tests pass, including 17 focused asset/portrait/rig checks.
- Neutral portrait pixels now start within the top 10% of every common viewport.
  CSS and Canvas address the same cropped pixels across all expression cells
  and both 192px/1254px sheet resolutions.
- The unchanged Darrius legacy body atlas still satisfies its original alpha
  and dimension contract. The portrait is now an intentional imagegen redraw,
  so its retired palette-only alpha digest was replaced by the shared framing
  checks rather than retained as a misleading requirement.
- All six rig file hashes match updated provenance.
- Headless Chromium captures at desktop and mobile widths show all six at
  identical portrait/body scales, both facings, all 24 weapon poses, wall-slide,
  dive and KO. Actual Duel UI captures also pass with no page errors or
  horizontal overflow; mobile emulation includes touch controls.

Task artifacts: `appearance-before/`, `appearance-after/`, `appearance-motion/`,
`appearance-game/`, `appearance-measurements.json`, `appearance-focused-tests.txt`,
and `appearance-client-tests.txt`. The before/after review is packaged as
`appearance-review.pdf` for Library delivery.

This pass is source-only. No Firebase deployment, Firestore migration or live
two-peer/physical-device qualification was performed.
