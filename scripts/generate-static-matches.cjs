#!/usr/bin/env node
// Generate a batch of static match docs for the Hosting-only spectate
// path. Combines:
//   - the 16 system STRATEGIES baked into @m3t4/sim
//   - any real registered stables in Firestore (when ADC is available)
//
// Output:
//   client/matches/index.json   — array of summaries with virtual schedule
//   client/matches/m-<id>.json  — full match doc per file
//
// Usage:
//   PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=500
//   PROJECT=m3ta-ai node scripts/generate-static-matches.cjs --count=200 --skip-firestore
//
// The virtual schedule means each match has a `virtualStartedAt` /
// `virtualEndsAt` that sit linearly in the future from `T0 = Date.now()`.
// The client picks the match whose virtual window contains "now" and
// loops modulo the total schedule length. Every spectator sees the same
// "current match" at any wall-clock moment — broadcast-style UX with
// zero server coordination.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const args = parseArgs(process.argv.slice(2));
const COUNT = Number(args.count ?? 500);
const SKIP_FIRESTORE = args["skip-firestore"] === true || args["skip-firestore"] === "true";
const PROJECT = process.env.PROJECT || process.env.GCLOUD_PROJECT || process.env.PLASMA_LAB_FIRESTORE_PROJECT_ID || "m3ta-ai";
const OUTPUT_DIR = path.resolve(__dirname, "..", "client", "matches");
const T0 = Date.now();

(async () => {
  if (!Number.isFinite(COUNT) || COUNT <= 0) {
    throw new Error("--count must be a positive integer");
  }

  // Load match-engine + sim from the workspace dist.
  const { runMatch, selectPair } = require("../match-engine/dist/index.js");
  const { STRATEGIES, STRATEGY_NAMES } = require("../sim/dist/strategies.js");

  // System roster: 16 strategies, each as a pseudo-stable with the
  // anchor ELO. These are always available and produce a varied pool
  // of matchups.
  const systemPool = STRATEGY_NAMES.map((name, idx) => ({
    userId: `system:${name}`,
    handle: name,
    slotId: `system-${name}`,
    slotName: name,
    config: STRATEGIES[name],
    // Stagger ELOs so pair selection has signal. Centred around 1500.
    elo: 1500 + ((idx * 37) % 800) - 400,
    isHuman: false,
    lastPlayedAt: 0,
  }));

  // Optionally load real registered users from Firestore.
  let humanPool = [];
  if (!SKIP_FIRESTORE) {
    try {
      humanPool = await loadHumanStables(PROJECT);
      console.log(`[generate-static-matches] loaded ${humanPool.length} human stables from Firestore`);
    } catch (e) {
      console.warn(`[generate-static-matches] could not load Firestore stables (${e.message}); proceeding with system roster only`);
    }
  }
  const pool = [...systemPool, ...humanPool];
  if (pool.length < 2) throw new Error("need at least 2 stables in pool");

  console.log(`[generate-static-matches] generating ${COUNT} matches from ${pool.length}-entry pool`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const summaries = [];
  let cursor = T0;

  for (let i = 0; i < COUNT; i++) {
    // Slight ELO jitter so selectPair produces variety across iterations.
    const jittered = pool.map((s) => ({
      ...s,
      elo: s.elo + Math.floor(((seededRand(i, s.userId) - 0.5) * 60)),
    }));
    const pair = selectPair({ active: jittered });
    if (!pair) {
      console.warn(`[generate-static-matches] iteration ${i}: selectPair returned null; skipping`);
      continue;
    }

    const matchId = `static-${T0.toString(36)}-${i.toString(36).padStart(3, "0")}-${crypto.randomBytes(2).toString("hex")}`;
    const startedAt = T0 + i; // unique per iteration; client uses virtualStartedAt for scheduling
    const { match } = runMatch({
      matchId,
      pair: { a: pair.a, b: pair.b },
      startedAt,
    });

    // Stitch this match into the virtual schedule.
    const virtualStartedAt = cursor;
    const virtualEndsAt = cursor + match.durationMs;
    cursor = virtualEndsAt;

    const enriched = { ...match, virtualStartedAt, virtualEndsAt };
    const filePath = path.join(OUTPUT_DIR, `${matchId}.json`);
    await fs.writeFile(filePath, JSON.stringify(enriched));

    summaries.push({
      matchId,
      stageId: match.stageId,
      virtualStartedAt,
      virtualEndsAt,
      durationMs: match.durationMs,
      a: { handle: match.a.handle, isHuman: match.a.isHuman, eloBefore: match.a.eloBefore },
      b: { handle: match.b.handle, isHuman: match.b.isHuman, eloBefore: match.b.eloBefore },
      winner: match.result.winner,
    });

    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${COUNT} matches generated`);
  }

  const totalScheduleMs = cursor - T0;
  const indexDoc = {
    schema: "m3t4.static-match-index.v1",
    generatedAt: T0,
    scheduleStartedAt: T0,
    totalScheduleMs,
    matchCount: summaries.length,
    poolSize: pool.length,
    systemCount: systemPool.length,
    humanCount: humanPool.length,
    matches: summaries,
  };
  await fs.writeFile(path.join(OUTPUT_DIR, "index.json"), JSON.stringify(indexDoc));

  console.log(`[generate-static-matches] done`);
  console.log(`  matches:           ${summaries.length}`);
  console.log(`  total schedule:    ${(totalScheduleMs / 60000).toFixed(1)} min`);
  console.log(`  output:            ${OUTPUT_DIR}`);

  // Quick size summary.
  const stats = await fs.readdir(OUTPUT_DIR);
  let totalBytes = 0;
  for (const f of stats) {
    const s = await fs.stat(path.join(OUTPUT_DIR, f));
    totalBytes += s.size;
  }
  console.log(`  total size on disk: ${(totalBytes / 1024 / 1024).toFixed(2)} MB across ${stats.length} files`);
})().catch((e) => {
  console.error("[generate-static-matches] failed:", e);
  process.exit(1);
});

async function loadHumanStables(project) {
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  const db = admin.firestore();
  const snap = await db.collection("stables").where("lastActiveAt", ">=", 0).get();
  const out = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const slots = Array.isArray(data.slots) ? data.slots : [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || !slot.config) continue;
      out.push({
        userId: data.userId,
        handle: data.handle,
        slotId: slot.slotId ?? `${data.userId}-${i}`,
        slotName: slot.name ?? `slot-${i}`,
        config: slot.config,
        elo: typeof slot.elo === "number" ? slot.elo : 1500,
        isHuman: !String(data.userId ?? "").startsWith("system:"),
        lastPlayedAt: typeof slot.lastPlayedAt === "number" ? slot.lastPlayedAt : 0,
      });
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.replace(/^--/, "").split("=");
    out[k] = v ?? true;
  }
  return out;
}

// Small deterministic PRNG so the same iteration produces the same jitter
// across regenerations (test-friendly).
function seededRand(i, salt) {
  const h = crypto.createHash("sha256").update(`${i}:${salt}`).digest();
  const u32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return u32 / 0xffffffff;
}
