# Head-scale appearance revision

This follow-up starts at source `b48e6dd`; deployment remains held for visual review.
Mark and Demis are the requested scale references. Equal image sizes and crown
padding alone did not establish equal head sizes. The regression now measures
actual opaque head spans through forehead/eye/cheek rows at a common 96px size.

| Portrait | Before approximate head width | Revised head width |
| --- | ---: | ---: |
| Demis (reference) | 49px | 49px |
| Mark (reference) | 64px | 64px |
| Jensen | 51px | 59px |
| Elon | 44px | 58px |

The median of 13 horizontal spans in the 25–55% vertical head band is used.
Jensen and Elon now lie inside the Mark/Demis reference range and within 12%
of its mean. This measures visible pixels, not atlas or viewport dimensions.
Both home CSS and Canvas HUD use equivalent source crops for all three bust
expressions. Full-body portrait cell 3 is unchanged in framing.

Four imagegen edits of inspected references retain transparent 1254px atlases:
Elon has cool pale skin, exposed scalp and sparse receding strands, with his
older, less idealized face retained. Jensen's hair is predominantly neutral
gray with restrained dark shadows. Their rig plates carry the same appearance.
Exact prompts are in `roster-headscale-prompts-2026-10-23.json`. Generated PNG
bytes were copied unchanged; no external raster edits or resizing were used.

All six fighters were reviewed at identical rendered scale, including both
facings. Actual home cards and Duel HUD were captured at 1440px and 390px;
no page errors or horizontal overflow. 107 client tests pass, including real
pixel head-width regression, CSS/Canvas crop equivalence and mirrored wrist/
socket/IK tests. Darius's approved PNGs remain byte-identical to the baseline.
Weapon assets, socket coordinates, bone sizes, animation and collision/sim
geometry are unchanged. Original checkout edits remain untouched.

Task artifacts: `headscale-v3-before/`, `headscale-v3-after/`,
`headscale-v3-game/`, `headscale-v3-tests.log` and `headscale-v3-review.pdf`.
The PDF contains before/after equal-scale sheets, mobile cards and actual HUD
captures, and is saved as a new version of the existing Library review.
No Firebase deployment, Firestore migration, live two-peer or physical-device
qualification is claimed.
