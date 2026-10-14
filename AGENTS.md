# m3t4 Agent Instructions

Applies to the whole `m3t4` repo unless a nested `AGENTS.md` overrides it.

## Current Product Direction

The user has authorized a minimal three-game home page at `/`: Meta Muzil at
`/muzil/`, Meta Duel at `/history`, and Mandate 2038 at `/mandate-2038/`.
Gamma owns Mandate sources; `tools/sync-mandate.mjs` packages its public
allowlist. `client/muzil/` owns the simulated phone and controllers;
`client/history/index.html` preserves the old arena entry.
`tools/sync-muzil-runtime.mjs` copies sibling Reploid/Doppler sources into
ignored `client/vendor/`, without model weights. `docs/meta-muzil.md` holds
implemented and target integration boundaries. Meta Muzil is the product
intent; historical ranked-arena and sidecar rules below still govern those
surfaces, whose evidence must not extend into broad mesh claims.

## Project Shape

- `client/` Firebase-hosted browser app; `sim/` deterministic TypeScript arena
  simulation; `server/` ranked arena API/worker service; `plasma-lab/`
  isolated distributed-compute sidecar; `pareto/` analysis/sweep toolkit.

## Git workflow: direct to main

- Commit on the owning repo's `main` and push to `origin/main`. No feature
  branches, branch-backed worktrees, or PRs unless the user asks for them.
- On another branch, preserve its work and move the task to `main` safely;
  never discard changes to switch. Never force-push `main`.
- Stage only task-related changes; integrate remote updates without
  overwriting unrelated work.
- Report the pushed commit or the concrete blocker. A local commit is not a push.

## Development verification

- During development, choose checks for the changed behavior: syntax/type checks,
  existing focused tests, or a local visual check. A command list is not a requirement
  to run every suite before each commit, push, or ordinary application deployment.
- Do not automatically run full repository suites, broad browser/device matrices,
  GPU/model campaigns, benchmarks, or full release qualification. Run them when
  explicitly requested or when a named correctness question cannot be answered by
  focused checks; state that reason before starting.
- Config-contract, mirror, drift, and freshness checks run only when the change
  edits what they check. Don't add tests that just restate another file or pin
  config literals. Time-box long processes.
- Once relevant checks pass, continue. Repeat or broaden verification only after
  another relevant change, a failure, or a concrete unresolved concern.
- For documentation-only edits, inspect the diff and changed links. Do not run
  application, GPU, browser, or benchmark suites for prose changes.
- For ordinary deployments, build the changed artifact where needed and check the
  affected route after deployment. Deployment alone does not require a new release
  qualification campaign.
- Keep existing acceptance thresholds and release-qualification requirements.
  Report exactly what was checked; focused development checks do not establish
  numerical qualification, performance, multi-device support, or full acceptance.

## Local Dirty Files

- Dirty assets, generated sprites, render experiments, and theme status files
  are user-owned unless the task targets them. Never revert unrelated dirty files.
- Keep commits narrow, named for the behavior or status change.
- `client/config.js` is tracked public deploy config. Do not put secrets in it.

## Verification Commands

Run the one that covers your change:

- Tests: sim `npm -w sim test`, client `npm run test:client`, server
  `npm -w server test`, plasma-lab `npm -w plasma-lab test`.
- Full app build: `npm run build`. Static content: `npm run check:content`.
  Client sim copy: `npm run check:client-sim`.
- Spot checks: `node --check <file>`, `git diff --check`.

When touching `sim/src`, run `npm -w sim run build` and update the browser copy
with `npm run sync:client-sim` (Hosting predeploy checks it).

## Distributed Compute Guardrails

- Ranked arena authority stays in `server`; `plasma-lab` is advisory sidecar
  compute.
- Public compute flags stay off and change only on explicit user request.
  `COMPUTE_ACCEPT_ASSIGNMENTS=false` is the safe default and primary rollback;
  open intake only when asked or intentionally smoking, in bounded admin
  windows (usually `durationMs: 30000`), then verify it returns to false.
- Production validation work requires receipt signatures. Workers must not
  receive server-held expected output hashes.
- Strict WebRTC proof claims need an explicit request and supporting smoke
  artifacts. Its tasks require `requiredTransport: "webrtc"` and
  `requiredPeerSubreceipt: true`; its parent receipt must link to an accepted
  server-issued peer subassignment and a verified peer-signed subreceipt.
- TURN is not a broad coverage claim until NAT-diverse testing says so.
- Do not claim public anonymous proof-of-useful-work, Sybil resistance,
  trusted browser/GPU execution, shared-buffer compute, or fused-kernel compute
  until docs and implementation support them.

## Intent-First Operations

- Asked what works: give a current scoreboard from server state, client build, plasma-lab smoke artifacts, production flags, and the docs claim boundary.
- Asked for deployed status: give the Firebase/app URL, config state, smoke result, and whether compute flags are enabled or safe-off.
- For visual/game behavior, verify deterministic sim and browser render state before changing public copy.

## Plasma-Lab Smoke Tests

Opt-in, not gates; run them when asked or when changing their path.

- Local sidecar: `npm -w plasma-lab run smoke`
- Hosted WebRTC artifact: `npm -w plasma-lab run smoke:webrtc-client-artifact`
- Hosted replay verify: `npm -w plasma-lab run smoke:webrtc-replay-verify`
- Hosted seed sweep: `npm -w plasma-lab run smoke:webrtc-seed-sweep`

Hosted smokes need `PLASMA_LAB_SMOKE_ORIGIN`, `PLASMA_LAB_SMOKE_ADMIN_TOKEN`,
and `M3T4_SMOKE_GAME_ORIGIN`. `PLASMA_LAB_SMOKE_REPEAT=N` runs repeat soaks.

## Deployment

- `PROVISIONING.md` is the deployment runbook.
- Hosting predeploy runs content sync, the client-sim sync check, runtime
  sync, and Mandate sync.
- With unrelated dirt, deploy from a clean temporary detached worktree so
  local files do not ship. For Hosting:
  1. create a temporary detached worktree at `HEAD` (`git worktree add --detach`)
  2. link or install dependencies
  3. run `npm -w sim run build`
  4. run `firebase deploy --only hosting --project m3ta-ai`
  5. remove the temporary worktree
- After Hosting deploy, verify `/config.js` serves JavaScript and, when
  relevant, a browser load with no page errors.
- Deploy `plasma-lab` separately from arena services.
- Never print or commit admin tokens, TURN credentials, Firebase service
  accounts, or scheduler secrets.

## Docs And Claims

- Update `docs/compute-lab-plan.md` (canonical local compute-lab runbook) for
  operational status, smoke IDs, flags, and rollback notes;
  `docs/distributed-compute.md` (public-safe claim boundary) for claim
  language; `../plasma` when task, receipt, validation,
  or proof contracts change; `../ouroboros` when product strategy or
  cross-repo roadmap status changes.
- Prefer section names and stable concepts over line-number anchors.
- Keep About-page language shorter than the docs, inside the same claim
  boundary.

## Frontend And Game Work

- Keep the first screen usable; do not hide app functionality behind
  landing-page copy.
- Preserve deterministic sim behavior unless the task is explicitly balance or
  mechanics work.
- Do not ship private bot logic or opponent configs to public clients.
- Render and sprite fixes are provable only in a browser, not from assets:
  before claiming one, check the affected desktop/mobile layout or canvas, or
  sprite facing, wall-slide, and mirrored animation.

## Before Final Response

- Mention production flags if compute behavior changed, and unrelated dirty
  files left alone.
- Keep the next recommendation concrete and short.

## No speculative engineering timelines

- Never predict how long engineering work will take ("1-2 weeks", "a quick
  fix"). Describe concrete deltas, dependencies, risks, and validation instead.
- For an already-running process, report measured elapsed time, progress, or a
  grounded ETA only when the process exposes one; otherwise report its phase,
  latest output, and whether it is still progressing.

## Pick the real fix

- Fix correctness bugs; don't relabel them. Effort or scope framing
  ("non-trivial", "worth its own thread", "later") is no reason for a lesser fix.
- "Mark experimental", "add a TODO", or "reword the misleading comment" does not
  substitute for fixing wrong behavior.
- If scope must be split, list the concrete deltas and ask the user which path
  to take; don't pre-decide a smaller version.
