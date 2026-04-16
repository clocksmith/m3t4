// Public API surface for @selfplay/sim

export * from "./types.js";
export * from "./constants.js";
export * from "./stage.js";
export { compileBrain, evaluateParams, compileAttribute, type CompiledBrain } from "./dsl.js";
export { runParamBrain } from "./brain.js";
export { simulate, simulateTrace, DEFAULT_CHARS, packAction, unpackAction, type SimulateOptions, type TraceFrame, type TraceResult } from "./simulate.js";
export { makeRng, type Rng } from "./rng.js";
export { STRATEGIES, STRATEGY_NAMES, SAMPLE_TRAJECTORIES, type StrategyName } from "./strategies.js";
