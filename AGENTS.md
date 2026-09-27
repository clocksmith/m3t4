# m3t4 Agent Instructions

These instructions apply to the whole `m3t4` repo unless a nested
`AGENTS.md` is added later.

## Project Shape

- `client/` is the Firebase-hosted browser app.
- `sim/` is the deterministic TypeScript arena simulation.
- `server/` is the ranked arena API/worker service.
- `plasma-lab/` is the isolated distributed-compute sidecar.
- `pareto/` is the analysis/sweep toolkit.
- `docs/compute-lab-plan.md` is the canonical local compute-lab runbook.
- `docs/distributed-compute.md` is the public-safe distributed-compute claim
  boundary.
- Related cross-repo contracts and strategy live in `../plasma` and
  `../ouroboros`.

## Git workflow: direct to main

- Work and commit directly on the owning repository's `main` branch, then push
  directly to its existing `origin/main` remote branch.
- Do not create feature/task branches, branch-backed worktrees, or GitHub pull
  requests. Do not use a branch/PR workflow unless the user explicitly requests it.
- If the checkout is on another branch, preserve its work and move the task to
  `main` safely; never discard changes to switch branches.
- Stage only task-related changes, run the applicable checks, and integrate remote
  updates without overwriting unrelated work. Never force-push `main`.
- Report the pushed commit or the concrete blocker. A local commit is not a push.
- Never revert unrelated dirty files. Current art/render/theme work is often
  dirty during generation passes.
- Keep commits narrow and named for the behavior or status change.

## Local Dirty Files

- Treat dirty assets, generated sprites, render experiments, and theme status
  files as user-owned unless the task specifically targets them.
- Before deploys, prefer a clean temporary detached worktree so unrelated local
  files do not ship accidentally.
- `client/config.js` is tracked public deploy config. Do not put secrets in it.

## Verification Commands

Run the smallest set that covers your change, then broaden for shared behavior.

- Sim changes: `npm -w sim test`
- Client tests: `npm run test:client`
- Server changes: `npm -w server test`
- Plasma-lab changes: `npm -w plasma-lab test`
- Full app build: `npm run build`
- Static content check: `npm run check:content`
- Client sim check: `npm run check:client-sim`
- JS syntax spot checks: `node --check <file>`
- Whitespace check before commit: `git diff --check`

When touching `sim/src`, run `npm -w sim run build` and sync/check the browser
copy with `npm run sync:client-sim` or `npm run check:client-sim`.

## Distributed Compute Guardrails

- Ranked arena authority stays in `server`; `plasma-lab` is advisory sidecar
  compute.
- Public compute flags stay off by default.
- `COMPUTE_ACCEPT_ASSIGNMENTS=false` is the safe default and the primary
  rollback.
- Open assignment intake only with bounded admin windows, usually
  `durationMs: 30000`, and verify it returns to false afterward.
- Production validation work requires receipt signatures.
- Workers must not receive server-held expected output hashes.
- Strict WebRTC proof tasks require `requiredTransport: "webrtc"` and
  `requiredPeerSubreceipt: true`.
- A strict WebRTC parent receipt must link to an accepted server-issued peer
  subassignment and a verified peer-signed subreceipt.
- TURN is not a broad coverage claim until NAT-diverse testing says so.
- Do not claim public anonymous proof-of-useful-work, Sybil resistance,
  trusted browser/GPU execution, shared-buffer compute, or fused-kernel compute
  until the docs and implementation actually support those claims.

## Intent-First Operations

- Treat m3t4 intent as ranked arena plus bounded distributed-compute experiments, not broad public compute claims.
- If the user asks what works, produce a current scoreboard from server state, client build, plasma-lab smoke artifacts, production flags, and docs claim boundary.
- Do not open public compute intake, change production flags, or claim strict WebRTC proof unless the user explicitly asks for that operation and the smoke artifacts support it.
- Ranked arena behavior belongs to `server`; advisory compute belongs to `plasma-lab`. Keep those authority boundaries explicit.
- If deployed status is requested, answer with Firebase/app URL, config state, smoke result, and whether compute flags are enabled or safe-off.
- For visual/game behavior, verify deterministic sim and browser render state before changing public copy.

## Plasma-Lab Smoke Tests

- Local sidecar smoke: `npm -w plasma-lab run smoke`
- Hosted WebRTC artifact smoke:
  `npm -w plasma-lab run smoke:webrtc-client-artifact`
- Hosted replay verify smoke:
  `npm -w plasma-lab run smoke:webrtc-replay-verify`
- Hosted seed sweep smoke:
  `npm -w plasma-lab run smoke:webrtc-seed-sweep`

For hosted smokes, set:

- `PLASMA_LAB_SMOKE_ORIGIN`
- `PLASMA_LAB_SMOKE_ADMIN_TOKEN`
- `M3T4_SMOKE_GAME_ORIGIN`

Use `PLASMA_LAB_SMOKE_REPEAT=N` for repeat soaks. Keep public flags off unless
the user explicitly asks for a controlled public window.

## Deployment

- Use `PROVISIONING.md` as the deployment runbook.
- Firebase Hosting has predeploy checks for content and client sim sync.
- For a clean Hosting deploy while the worktree has unrelated dirt:
  1. create a temporary detached worktree at `HEAD` (`git worktree add --detach`)
  2. link or install dependencies
  3. run `npm -w sim run build`
  4. run `firebase deploy --only hosting --project m3ta-ai`
  5. remove the temporary worktree
- After Hosting deploy, verify `/config.js` serves JavaScript and do a browser
  load check with no page errors when relevant.
- Deploy `plasma-lab` separately from arena services. Keep
  `COMPUTE_ACCEPT_ASSIGNMENTS=false` unless intentionally smoking.
- Never print or commit admin tokens, TURN credentials, Firebase service
  accounts, or scheduler secrets.

## Docs And Claims

- Update `docs/compute-lab-plan.md` for operational status, smoke IDs, flags,
  and rollback notes.
- Update `docs/distributed-compute.md` for public-safe claim language.
- Update `../plasma` when task, receipt, validation, or proof contracts change.
- Update `../ouroboros` when product strategy or cross-repo roadmap status
  changes.
- Prefer section names and stable concepts over brittle line-number anchors.
- Keep About-page language shorter than the docs and inside the same claim
  boundary.

## Frontend And Game Work

- Do not hide useful app functionality behind landing-page copy.
- Keep the first screen usable.
- Preserve deterministic sim behavior unless the task is explicitly balance or
  mechanics work.
- Do not ship private bot logic or opponent configs to public clients.
- When editing render code, verify both desktop and mobile layouts or canvas
  behavior as appropriate.
- When changing sprites, confirm facing, wall-slide, and mirrored animation
  behavior in the browser, not only by inspecting assets.

## Before Final Response

- Report what changed, what was verified, and what remains intentionally
  unverified.
- Mention production flags if compute behavior was touched.
- Mention unrelated dirty files that were left untouched.
- Keep the next recommendation concrete and short.

## No speculative engineering timelines

- Do not predict how long a coding, software-engineering, product-implementation, refactor, migration, launch, or similar work item will take. Avoid speculative delivery statements such as "1-2 weeks", "four months", or "a quick fix".
- Describe planned work through concrete deltas, dependencies, risks, and validation instead of calendar duration.
- This restriction does not apply to factual status for an already-running command, script, benchmark, training run, skill, deployment, or algorithm. You may report elapsed time, measured runtime, progress, and a grounded ETA when the active process exposes enough evidence.
- Do not invent an ETA for an active process. If it does not expose one, report its current phase, latest output, and whether it is still making progress.

## Pick the real fix

- when you find a correctness bug, the default is to fix it, not to relabel it
- do not use effort or scope framing ("non-trivial", "real engineering effort", "worth its own thread", "we'll address later") as cover for choosing a lesser fix
- do not propose "mark experimental", "add a TODO", or "rewrite the misleading comment" as a substitute for the actual engineering work when the underlying behavior is wrong
- if scope genuinely must be split, describe the concrete deltas and ask the user which path to take, do not pre-decide a smaller version
