#!/usr/bin/env node
// Bounded LOCAL evaluation. No Firebase imports, credentials, network, Watch
// index writes, or authoritative ranking updates. See docs/fighter-evaluation.md.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  BACKGROUND_HISTORY_LIMIT, BACKGROUND_ROSTER_LIMIT, BACKGROUND_SCHEDULER_VERSION,
  evaluationFighterKey, evaluationSeed, evaluationUncertainty, runMatch, selectBackgroundPair,
} from '../match-engine/dist/index.js';
import { BEHAVIOR_VERSION, REPLAY_CONSTANTS_HASH, STAGES, compileBrain } from '../sim/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Local fighter evaluation (never publishes or contacts Firestore)
  node scripts/evaluate-fighter-roster.mjs --roster=data/m3t4.json \\
    --seed=20261022 --count=100 --max-seconds=60 --out=/tmp/fighter-eval

Required: --roster, --seed (uint32), --count (1..10000), --max-seconds (0..3600, exclusive 0)
Optional: --out (NEW directory, parent must exist), --stage (default datacenter),
          --pair-cooldown (default 8), --fighter-cooldown (default 1), --placement-games (default 6)
The deadline is checked between matches; one already-started bounded simulation finishes.
Outputs are private local evidence, not featured Watch content or live standings.
Build first: npm -w sim run build && npm -w match-engine run build`;

export function parseOptions(argv) {
  const values = {};
  const allowed = new Set(['roster', 'seed', 'count', 'max-seconds', 'out', 'stage', 'pair-cooldown', 'fighter-cooldown', 'placement-games']);
  for (const argument of argv) {
    if (argument === '--help') return { help: true };
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) throw new Error(`unknown, duplicate, or malformed option: ${argument}`);
    values[match[1]] = match[2];
  }
  for (const required of ['roster', 'seed', 'count', 'max-seconds']) {
    if (!values[required]) throw new Error(`--${required} is required; use --help`);
  }
  const integerOption = (key, fallback, min, max) => {
    const value = values[key] === undefined ? fallback : Number(values[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} must be an integer in [${min}, ${max}]`);
    return value;
  };
  const maxSeconds = Number(values['max-seconds']);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 3600) throw new Error('--max-seconds must be > 0 and <= 3600');
  const seed = integerOption('seed', undefined, 0, 0xffffffff);
  const stageId = values.stage ?? 'datacenter';
  if (!Object.hasOwn(STAGES, stageId)) throw new Error('unknown --stage');
  return {
    roster: resolve(values.roster), seed, maxSeconds, stageId,
    count: integerOption('count', undefined, 1, 10000),
    out: resolve(values.out ?? `/tmp/m3t4-evaluation-${seed}-${Date.now()}`),
    pairCooldown: integerOption('pair-cooldown', 8, 0, 256),
    fighterCooldown: integerOption('fighter-cooldown', 1, 0, 256),
    placementGames: integerOption('placement-games', 6, 1, 32),
  };
}

export function readRoster(document) {
  let fighters;
  if (document?.schema === 'm3t4.evaluation-roster.v1' && Array.isArray(document.fighters)) {
    fighters = document.fighters.map((fighter) => structuredClone(fighter));
  } else if (document?.stables && typeof document.stables === 'object' && !Array.isArray(document.stables)) {
    fighters = Object.entries(document.stables).flatMap(([owner, stable]) => {
      if (!stable || stable.userId !== owner || !Array.isArray(stable.slots)) throw new Error('invalid stable identity or slots');
      return stable.slots.flatMap((slot, slotIdx) => slot === null ? [] : [{
        ...slot, userId: stable.userId, handle: stable.handle,
        slotIdx, slotName: slot.name, isHuman: !stable.userId.startsWith('system:'),
      }]);
    });
  } else throw new Error('expected m3t4.evaluation-roster.v1 fighters or a checked-in {stables} roster');
  if (fighters.length < 2 || fighters.length > BACKGROUND_ROSTER_LIMIT) throw new Error(`roster requires 2..${BACKGROUND_ROSTER_LIMIT} fighters`);
  const keys = new Set();
  for (const fighter of fighters) {
    for (const field of ['userId', 'slotId', 'slotName', 'handle']) {
      if (typeof fighter[field] !== 'string' || !fighter[field].trim()) throw new Error(`fighter requires ${field}`);
    }
    if (!Number.isFinite(fighter.elo)) throw new Error('fighter elo must be finite');
    for (const field of ['wins', 'losses', 'draws', 'gamesPlayed']) {
      if (fighter[field] !== undefined && (!Number.isSafeInteger(fighter[field]) || fighter[field] < 0)) throw new Error(`invalid ${field}`);
    }
    if (fighter.uncertainty !== undefined && (!Number.isFinite(fighter.uncertainty) || fighter.uncertainty < 0 || fighter.uncertainty > 1000)) throw new Error('invalid uncertainty');
    if (fighter.style !== undefined && typeof fighter.style !== 'string') throw new Error('style must be a string');
    if (fighter.isHuman !== undefined && typeof fighter.isHuman !== 'boolean') throw new Error('isHuman must be boolean');
    if (fighter.slotIdx !== undefined && (!Number.isSafeInteger(fighter.slotIdx) || fighter.slotIdx < 0)) throw new Error('slotIdx must be a nonnegative integer');
    if (fighter.lastPlayedAt !== undefined && !Number.isFinite(fighter.lastPlayedAt)) throw new Error('lastPlayedAt must be finite');
    if (!fighter.config || typeof fighter.config.id !== 'string' || !fighter.config.attributes || typeof fighter.config.attributes !== 'object' || Array.isArray(fighter.config.attributes)) throw new Error('fighter requires BrainConfig');
    if (fighter.config.configVersion !== undefined && fighter.config.configVersion !== 1) throw new Error('evaluation requires native-unit configVersion 1; do not pass UI-space configs');
    assertFiniteNumbers(fighter.config);
    compileBrain(fighter.config); // Compile/validate without rewriting config or budget.
    const key = evaluationFighterKey(fighter);
    if (keys.has(key)) throw new Error('duplicate fighter identity');
    keys.add(key);
  }
  if (new Set(fighters.map((fighter) => fighter.userId)).size < 2) throw new Error('roster requires at least two distinct owners');
  return fighters;
}

export function evaluateRoster(options) {
  if (statSync(options.roster).size > 4 * 1024 * 1024) throw new Error('roster exceeds 4 MiB input limit');
  const input = readFileSync(options.roster);
  const fighters = readRoster(JSON.parse(input.toString('utf8')));
  const rosterSha256 = sha256(input);
  const canonicalOut = join(realpathSync(dirname(options.out)), options.out.split(/[\\/]/).at(-1));
  const clientRoot = realpathSync(join(root, 'client'));
  if (isWithin(clientRoot, canonicalOut)) throw new Error('evaluation output cannot be inside the public client tree');
  if (existsSync(options.out)) throw new Error('output directory already exists; choose a new directory to preserve prior evidence');
  mkdirSync(options.out, { mode: 0o700 });
  mkdirSync(join(options.out, 'matches'), { mode: 0o700 });
  writeFileSync(join(options.out, 'roster.input.json'), input, { flag: 'wx', mode: 0o600 });
  const engine = {
    schedulerVersion: BACKGROUND_SCHEDULER_VERSION,
    behaviorVersion: BEHAVIOR_VERSION,
    constantsHash: REPLAY_CONSTANTS_HASH,
    buildSha256: buildFingerprint(),
  };
  const bounds = {
    count: options.count, maxSeconds: options.maxSeconds,
    deadline: 'between-matches; an in-flight bounded simulation completes',
    historyLimit: BACKGROUND_HISTORY_LIMIT, rosterLimit: BACKGROUND_ROSTER_LIMIT,
  };
  const manifest = {
    schema: 'm3t4.evaluation-run.v1', lane: 'background-evaluation', featured: false,
    seed: options.seed, rosterSha256, engine, bounds,
    stageId: options.stageId, kFactor: 16,
    scheduler: { pairCooldown: options.pairCooldown, fighterCooldown: options.fighterCooldown, placementGames: options.placementGames },
    inputFormat: 'roster.input.json is the exact original input; contains private configs; do not publish',
    ratingScope: 'local evaluation only; imported stats and authoritative ratings are never overwritten',
    generatedAt: new Date().toISOString(),
  };
  writeJson(join(options.out, 'manifest.json'), manifest);
  writeFileSync(join(options.out, 'schedule.jsonl'), '', { flag: 'wx', mode: 0o600 });

  const state = new Map(fighters.map((fighter) => {
    const gamesPlayed = fighter.gamesPlayed ?? ((fighter.wins ?? 0) + (fighter.losses ?? 0) + (fighter.draws ?? 0));
    const initial = { ...fighter, gamesPlayed, evaluations: 0 };
    return [evaluationFighterKey(fighter), {
      ...initial, initialGames: gamesPlayed, initialElo: fighter.elo,
      initialUncertainty: evaluationUncertainty(initial),
      evaluationWins: 0, evaluationLosses: 0, evaluationDraws: 0,
      opponents: new Set(), sides: [0, 0], configSha256: sha256(JSON.stringify(fighter.config)),
    }];
  }));
  const history = [], schedule = [], durations = [], matchups = new Map();
  const started = performance.now();
  let stopReason = 'count-limit', failure;
  try {
    for (let sequence = 0; sequence < options.count; sequence++) {
      if (performance.now() - started >= options.maxSeconds * 1000) { stopReason = 'time-limit'; break; }
      const selection = selectBackgroundPair({
        ...options, fighters: [...state.values()], history, sequence,
      });
      if (!selection) { stopReason = 'no-legal-pair'; break; }
      const a = state.get(selection.a), b = state.get(selection.b);
      const simulationSeed = evaluationSeed(options.seed, sequence);
      // runMatch derives its seed from startedAt + Elo. Solve that exact
      // existing formula, not a second simulation implementation. This is a
      // synthetic clock for replay only, NOT a wall-clock/Watch schedule.
      const startedAt = (simulationSeed ^ (a.elo << 3) ^ b.elo) >>> 0;
      const matchId = `evaluation-${options.seed.toString(16)}-${String(sequence).padStart(6, '0')}`;
      const before = performance.now();
      const output = runMatch({ matchId, stageId: options.stageId, startedAt, pair: { a: matchStable(a), b: matchStable(b) }, kFactor: 16 });
      durations.push(performance.now() - before);
      const { match, eloAfter } = output;
      const entry = { sequence, matchId, simulationSeed, selection, actionLogHash: match.actionLogHash };
      const evidence = {
        schema: 'm3t4.evaluation-match.v1', lane: 'background-evaluation', featured: false,
        ...entry,
        provenance: {
          rosterSha256, engine,
          configSha256: { [selection.a]: a.configSha256, [selection.b]: b.configSha256 },
          ratingScope: 'local-evaluation', simulationClock: 'synthetic', kFactor: 16,
        },
        match,
      };
      // Persist EVERY completed result and action log before doing bookkeeping.
      writeJson(join(options.out, 'matches', `${matchId}.json`), evidence);
      appendFileSync(join(options.out, 'schedule.jsonl'), `${JSON.stringify(entry)}\n`);
      schedule.push(entry);
      const displayed = [evaluationFighterKey(match.a), evaluationFighterKey(match.b)];
      for (let side = 0; side < 2; side++) {
        const fighter = state.get(displayed[side]);
        fighter.elo = side === 0 ? eloAfter.a : eloAfter.b;
        fighter.evaluations++;
        fighter.gamesPlayed = fighter.initialGames + fighter.evaluations;
        fighter.uncertainty = Math.max(0, fighter.initialUncertainty / Math.sqrt(1 + fighter.evaluations / 4));
        fighter[match.result.winner === -1 ? 'evaluationDraws' : match.result.winner === side ? 'evaluationWins' : 'evaluationLosses']++;
        fighter.opponents.add(displayed[1 - side]);
        fighter.sides[side]++;
      }
      history.push({ sequence, a: selection.a, b: selection.b });
      if (history.length > BACKGROUND_HISTORY_LIMIT) history.shift();
      const key = JSON.stringify([selection.a, selection.b].sort());
      matchups.set(key, (matchups.get(key) ?? 0) + 1);
    }
  } catch (error) {
    stopReason = 'error';
    failure = error;
    writeJson(join(options.out, 'failure.json'), { message: String(error?.message ?? error), completed: schedule.length });
  }
  const elapsedMs = performance.now() - started;
  const orderedDurations = [...durations].sort((a, b) => a - b);
  const publicRows = [...state].map(([id, fighter]) => ({
    id, userId: fighter.userId, slotId: fighter.slotId, name: fighter.slotName,
    importedElo: fighter.initialElo, evaluationElo: fighter.elo,
    importedGames: fighter.initialGames, evaluations: fighter.evaluations,
    wins: fighter.evaluationWins, losses: fighter.evaluationLosses, draws: fighter.evaluationDraws,
    distinctOpponents: fighter.opponents.size, sides: fighter.sides,
  })).sort((a, b) => b.evaluationElo - a.evaluationElo || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const possiblePairs = fighters.reduce((total, fighter, i) => total + fighters.slice(i + 1).filter((other) => other.userId !== fighter.userId).length, 0);
  const summary = {
    schema: 'm3t4.evaluation-summary.v1', lane: 'background-evaluation', featured: false,
    stopReason, completed: schedule.length, requested: options.count, seed: options.seed,
    rosterSha256, engine,
    scheduleSha256: sha256(schedule.map((entry) => JSON.stringify(entry)).join('\n')),
    runtime: {
      elapsedMs, matchesPerSecond: elapsedMs ? schedule.length * 1000 / elapsedMs : 0,
      simulationMs: durations.reduce((sum, value) => sum + value, 0),
      p50MatchMs: percentile(orderedDurations, 0.5), p95MatchMs: percentile(orderedDurations, 0.95),
      maxMatchMs: orderedDurations.at(-1) ?? 0,
      maxRssKiB: process.resourceUsage().maxRSS,
      traceNote: 'existing runMatch allocates simulateTrace frames; full frames are not retained or persisted',
    },
    distribution: {
      rosterSize: fighters.length, fightersEvaluated: publicRows.filter((fighter) => fighter.evaluations > 0).length,
      possiblePairs, distinctPairs: matchups.size, pairCoverage: matchups.size / possiblePairs,
      placementMatches: schedule.filter((entry) => entry.selection.reason === 'placement').length,
      fighterCooldownFallbacks: schedule.filter((entry) => entry.selection.relaxedFighterCooldown).length,
      unavoidablePairRepeats: schedule.filter((entry) => entry.selection.relaxedPairCooldown).length,
      minEvaluations: Math.min(...publicRows.map((fighter) => fighter.evaluations)),
      maxEvaluations: Math.max(...publicRows.map((fighter) => fighter.evaluations)),
      meanEloGap: schedule.length ? schedule.reduce((sum, entry) => sum + entry.selection.rawEloGap, 0) / schedule.length : 0,
      matchups: [...matchups].map(([key, count]) => ({ fighters: JSON.parse(key), count })),
    },
    fighters: publicRows,
  };
  writeJson(join(options.out, 'summary.json'), summary);
  if (failure) throw failure;
  return summary;
}

function matchStable(fighter) {
  // Keep private configs and unknown input fields out of public match metadata.
  // Config is passed privately to runMatch; only known cosmetics are forwarded.
  const cosmetics = {};
  for (const key of ['body', 'weapon']) if (typeof fighter.cosmetics?.[key] === 'string') cosmetics[key] = fighter.cosmetics[key];
  return {
    userId: fighter.userId, slotId: fighter.slotId, slotIdx: fighter.slotIdx,
    slotName: fighter.slotName, handle: fighter.handle, config: fighter.config,
    elo: fighter.elo, isHuman: fighter.isHuman ?? false, lastPlayedAt: fighter.lastPlayedAt ?? 0,
    cosmetics,
  };
}
function buildFingerprint() {
  const hash = createHash('sha256');
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name === 'test') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.js')) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  visit(join(root, 'sim', 'dist'));
  visit(join(root, 'match-engine', 'dist'));
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  return hash.digest('hex');
}
function assertFiniteNumbers(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('config contains non-finite number');
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertFiniteNumbers(child);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function percentile(sorted, fraction) { return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0; }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function isWithin(parent, target) { const part = relative(parent, target); return part === '' || (part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)); }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const result = evaluateRoster(options);
      console.log(JSON.stringify({
        completed: result.completed, stopReason: result.stopReason, out: options.out,
        matchesPerSecond: result.runtime.matchesPerSecond,
        fightersEvaluated: result.distribution.fightersEvaluated, rosterSize: result.distribution.rosterSize,
        distinctPairs: result.distribution.distinctPairs, possiblePairs: result.distribution.possiblePairs,
        unavoidablePairRepeats: result.distribution.unavoidablePairRepeats,
        scheduleSha256: result.scheduleSha256,
      }, null, 2));
    }
  } catch (error) {
    console.error(`[evaluate-fighter-roster] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
