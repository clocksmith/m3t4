# Shared Watch, Tune and Play arena

All three routes use one presentation shell and one viewport-fit calculation.
At the same viewport and app chrome size, the canvas rectangle is identical.
The 1280×720 logical simulation viewport is preserved; only CSS presentation
size changes. The renderer keeps its existing integer backing-store policy.

The toolbar occupies a fixed, shared region. Setup, fighter editors, audio,
rankings and diagnostics live in a centered native modal dialog. They are moved,
not re-rendered: opening or closing settings preserves the canvas, renderer,
match seed, editor values and active feed. Start/Test, Pause/Resume and Settings
remain available outside the dialog. Play's movement/strike touch controls stay
attached to the arena and retain their coarse-pointer visibility behavior.

Local Play and Tune freeze simulation/playback while settings are open, then
restore the prior manually-paused state. A running local match resumes without
accumulating the time spent in the dialog. Held keyboard and pointer inputs are
released on open and close. Online Play does not claim a local pause can pause
its peer; it sends neutral local input while settings are open. Watch continues
receiving and showing its feed. No simulation rule, AI, ranking or replay engine
changes are included.

The native dialog supplies modal focus containment. Done and Escape close it,
restore the opener, and do not replace match state. Closing during route teardown
removes listeners without calling back into a new mode. Resize observers and
visual-viewport/fullscreen listeners are torn down with the route.

## Focused checks

- `node --test client/test/arena-shell.test.mjs client/test/fighter-modes.test.mjs`
- `npm run test:client`
- Start the repository preview and open `/test/arena-layout.html`, then run the
  responsive checks. This uses actual same-origin route documents at desktop,
  narrow and landscape CSS viewport sizes. It is not real mobile-device or
  touch-hardware qualification. The fixture is under `client/test/`, excluded
  from Hosting by the existing deployment ignore.

The browser harness checks cross-route bounds, exact aspect ratio, modal bounds,
canvas identity, focus restoration, local pause/resume, seed preservation, and
that closing settings does not resume a manually-paused match. It waits for
bounded readiness and stable layout rather than assuming a fixed network/render
delay. The fixture makes no ranked or profile writes. For a narrow portrait capture,
append `?portrait=1`. The fixture exposes real movement controls for its input
checks, verifies at least 44×44 CSS pixel targets inside the arena, and confirms
a latched pointer is cleared when settings open. Synthetic pointer coverage is
not a claim of real touchscreen or coarse-pointer hardware qualification.

Observed in the cloud Chromium browser at the same CSS viewport:

| Viewport | All three routes: x, y, width, height |
| --- | --- |
| 1180×757 | 42.4375, 133, 1095.109375, 616 |
| 390×844 | 8, 129, 374, 210.375 |
| 844×390 | 200.671875, 133, 442.65625, 249 |

The modal did not change any rectangle. Actual top-level Play checks additionally
used the native Escape and Done controls, observed a frozen tick while settings
were open, and confirmed the same match seed continued after closing. The
focused shell/mode suite passed 7 tests; the complete client suite passed 85.
Simulation/AI/replay implementation and data are byte-unchanged by this UI delta.
