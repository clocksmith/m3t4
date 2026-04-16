#!/usr/bin/env node
// Headless match CLI. Runs a match between two configs and prints the outcome.
//
// Usage:
//   selfplay-sim --a blitz --b shipper --seed 1 [--stage datacenter] [--json]
//   selfplay-sim --a path/to/a.json --b path/to/b.json --seed 42
//   selfplay-sim --determinism <name> --n 100   # run same match N times, check hash
//
// Prints: winner, final score, final rounds, ticks, log hash.
import fs from "node:fs";
import { simulate } from "./simulate.js";
import { STAGES } from "./stage.js";
import { STRATEGIES, STRATEGY_NAMES } from "./strategies.js";
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k.startsWith("--")) {
            const name = k.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                out[name] = next;
                i++;
            }
            else
                out[name] = "1";
        }
    }
    return out;
}
function resolveBrain(spec) {
    if (STRATEGY_NAMES.includes(spec)) {
        return STRATEGIES[spec];
    }
    if (fs.existsSync(spec)) {
        const raw = JSON.parse(fs.readFileSync(spec, "utf8"));
        if (!raw.id)
            raw.id = spec.replace(/[/.]/g, "_");
        return raw;
    }
    throw new Error(`Unknown brain '${spec}'. Use a strategy name (${STRATEGY_NAMES.join(", ")}) or a JSON path.`);
}
const args = parseArgs(process.argv);
if (args.determinism) {
    // Run the same match N times, assert frame-log hashes match.
    const strat = resolveBrain(args.determinism);
    const oppName = args.opp ?? "thesis";
    const opp = resolveBrain(oppName);
    const n = parseInt(args.n ?? "20", 10);
    const seed = parseInt(args.seed ?? "1", 10);
    const stage = STAGES[args.stage ?? "datacenter"];
    let firstHash = "";
    for (let i = 0; i < n; i++) {
        const r = simulate({ stage, brainA: strat, brainB: opp, seed });
        if (i === 0)
            firstHash = r.logHash;
        else if (r.logHash !== firstHash) {
            console.error(`FAIL: run ${i} produced hash ${r.logHash} vs run 0 ${firstHash}`);
            process.exit(1);
        }
    }
    console.log(`OK: ${n} runs of ${args.determinism} vs ${oppName} all hash to ${firstHash}`);
    process.exit(0);
}
const aSpec = args.a ?? "blitz";
const bSpec = args.b ?? "shipper";
const stageName = args.stage ?? "datacenter";
const seed = parseInt(args.seed ?? "1", 10);
const asJson = !!args.json;
const stage = STAGES[stageName];
if (!stage) {
    console.error(`Unknown stage '${stageName}'. Choices: ${Object.keys(STAGES).join(", ")}`);
    process.exit(2);
}
const brainA = resolveBrain(aSpec);
const brainB = resolveBrain(bSpec);
const result = simulate({ stage, brainA, brainB, seed });
if (asJson) {
    console.log(JSON.stringify({
        winner: result.winner,
        seed: result.seed,
        ticks: result.ticks,
        finalScore: result.finalScore,
        finalRounds: result.finalRounds,
        logHash: result.logHash,
        stage: stageName,
        a: aSpec,
        b: bSpec,
    }, null, 2));
}
else {
    const winner = result.winner;
    const wname = winner === -1 ? "DRAW" : winner === 0 ? aSpec : bSpec;
    console.log(`stage=${stageName} seed=${result.seed}`);
    console.log(`${aSpec} vs ${bSpec}`);
    console.log(`rounds: ${result.finalRounds[0]}-${result.finalRounds[1]}  score: ${result.finalScore[0]}-${result.finalScore[1]}`);
    console.log(`winner: ${wname}  ticks=${result.ticks}  hash=${result.logHash}`);
}
