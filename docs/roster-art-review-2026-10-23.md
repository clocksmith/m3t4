# Duel roster visual and weapon motion correction

Completed locally on 2026-10-23. Unpublished: no push, deployment, Firestore
migration, or Doe changes. Work is isolated under this task's `m3t4/` clone on
main, based on Mars source commit `0fafffa`. The original Mars checkout and all
its active edits were preserved. Initial dirty files were HUD changes in
`client/render/canvas2d.js` and `client/render/index.js`; additional work became
active during this task and was also left untouched.

## Shared art direction

All six fighters now use imagegen-authored layered pixel-art plates in
`client/assets/chars/rig-v1/`. The explicit style reference was Sama's original
`client/assets/chars/sama/monastic_infra/sprite.png`: a narrow adult silhouette,
small head, hard dark outline and sparse material shading. The prototype was
visually inspected before the other characters were adapted from it. The six
new plates have matching source layout and were inspected individually and
assembled together in the actual browser renderer.

| Fighter | Retained identity | New runtime source |
| --- | --- | --- |
| sama | dark hair, navy sweater, faded blue jeans | `assets/chars/rig-v1/sama.png` |
| darrius | curls, glasses, charcoal blazer, brown trousers | `assets/chars/rig-v1/darrius.png` |
| demis | bald head, blue glasses, navy suit and tie | `assets/chars/rig-v1/demis.png` |
| mark | light brown curls, bare arms, sleeveless purple athletic outfit | `assets/chars/rig-v1/mark.png` |
| jensen | silver hair, glasses, black leather jacket | `assets/chars/rig-v1/jensen.png` |
| elon | swept dark hair, charcoal jacket | `assets/chars/rig-v1/elon.png` |

Jensen and Elon's smooth chibi portrait sheets were also regenerated against
Sama's crisp portrait style. Existing paths are retained, preserving three
expression cells and a full-body cell. Source images are 1254x1254; HUD cells
are measured from natural image dimensions instead of assuming a 192px sheet.
Existing CSS portrait consumers already use a proportional 2x2 grid.

The first attempted conventional Jensen atlas failed the exact frame-size and
proportion requirements and was rejected. Instead of guessing a regular atlas
or editing raster bytes, this implementation uses validated part rectangles:
head, torso, upper arm, forearm, fist, thigh and shin. Original generated PNG
bytes, including alpha, are copied intact. Canvas draws these parts at the same
56px standing height, 12px torso width, 10x12px head footprint and ground origin.
Nearest-neighbour sampling is explicit. There was no Python, image-library,
or ad hoc raster rewriting/resizing. `rig-v1/provenance.json` records generation
inputs, prompts and hashes.

The trade-off is deliberate: fixed full-body frame playback becomes a
continuous joint rig. It eliminates baked spare arms and lets the same artwork
perform each weapon's motion. Legs have a deterministic two-part run/jump/fall/
wall/dive/KO pose; torso lean supports running, striking and hit recoil. Every
run sample plants a foot at the same baseline. The legacy sheets remain as an
asset-failure fallback, including their old frame-origin repairs.

## Exact weapon and hand semantics

`sim/src/weapon-kinematics.ts` owns immutable version-1 profiles for all 24
weapons. Each has explicit type, duration, reach, windup, strike end, recovery
and support-grip distance. Per-cell art grip/tip axes remain calibrated in
`client/render/fighter-art.js`.

- Clubs, axes, mauls and blades have distinct anticipation and overhead strike
  paths, weights/timings, reach and recovery.
- Pikes/lances retract at the hip, thrust on a level axis, then withdraw.
- Flails have separate grip, handle joint and lagging head. Chain and handle
  rotate independently; damage uses the head, never the empty grip-to-head chord.
- Nunchucks have a handle, short flexible joint and separate distal baton; the
  distal baton is the damaging segment.
- A weapon's primary grip is a world socket. Two-bone IK solves the actual
  shoulder/elbow/wrist to that point. Support hands use a second axial socket
  on a visible rear handle, not an arbitrary screen offset. All coordinates
  reflect in fighter-local X before world placement.
- New weapon damage/clashes occur in the strike phase or dive; windup and
  recovery do not leave an invisible passive foil active. Combat debug draws
  those actual hit segments. KO drops the live weapon.

The renderer and simulation consume the same versioned geometry. Character
frames carry `body`, `weapon`, and `weaponMotionVersion: 1`, so replay labels
cannot silently substitute another collision weapon. New Play/Tune matches and
both server match factories persist this identity. Existing replay characters
without the marker keep their exact historical always-extended foil behavior.
No stored records were rewritten. Version 1 intentionally changes outcomes of
new matches; this is functional weapon motion, not a cosmetic relabeling.

## Validation

- Sim build and browser sim synchronization pass.
- 31 focused simulation/geometry/replay tests pass, including all 24 profiles
  through both facings, continuous phase boundaries, thrusts, lagging flexible
  joints, damage gating and deterministic trace identity.
- All 98 client tests pass. They include actual rig draw matrices, exactly two
  arms, exact IK bone lengths, mirrored grip sockets, all source rectangles
  containing real pixels, and grounded feet throughout a full run cycle.
- 9 server/match-boundary tests pass, including replaying a newly generated
  lance-versus-flail match from the persisted action log and characters.
- Server and match-engine TypeScript builds pass; `git diff --check` passes.
- Headless Chromium contact sheets at widths 1440 and 390 use all six generated
  rigs, all 24 actual weapon textures, idle plus four attack samples, both
  facings, wall-slide, dive and KO. The harness waits for real rig and weapon
  draw calls; loading fallbacks cannot pass the capture assertions.
- Actual `/duel` UI controls select lance, nunchucks and flail, start local
  matches and capture the arena at both widths. No page errors or horizontal
  overflow. External requests are blocked; this is local desktop/mobile canvas
  evidence, not a production or physical-device qualification claim.

Reproduce:

```
npm -w sim run build
npm run sync:client-sim
npm run test:client
node --test sim/dist/test/combat-geometry.test.js sim/dist/test/weapon-kinematics.test.js sim/dist/test/replay-rules.test.js sim/dist/test/replay.test.js
npm -w match-engine run build
npm -w server run build
node --test match-engine/dist/test/weapon-identity.test.js server/dist/test/stable-cosmetics.test.js
node tools/roster-art-review.mjs OUTPUT
node tools/roster-game-review.mjs OUTPUT
```

## Deliverables and status

Task workspace `artifacts/before-v2/` and `artifacts/after-v2/` contain matching
contact sheets and JSON capture reports. `artifacts/game-v2/` contains actual
Duel UI and arena captures. Test transcripts are under `artifacts/`.
`artifacts/m3t4-roster-review.pdf` packages before/after images and in-game
captures for sharing. Publication is intentionally held for parent review.
No action is denied, pending, or of uncertain outcome. Physical-device testing
and competitive balance qualification were outside this local visual task.
