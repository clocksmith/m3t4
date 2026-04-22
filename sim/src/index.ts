// Public API surface for @m3t4/sim

export * from "./types.js";
export * from "./constants.js";
export * from "./stage.js";
export * from "./budget.js";
export * from "./replay.js";
export { compileBrain, evaluateParams, compileAttribute, type CompiledBrain } from "./dsl.js";
export { BEHAVIOR_VERSION, runParamBrain, createBrainState, resetBrainStateForRound } from "./brain.js";
export {
  simulate, simulateTrace, DEFAULT_CHARS, packAction, unpackAction,
  applyHallucinationNoise, applyMicroAttributeDrift, createStepperWorld, runBrainForWorld, settleWorldWinner, stepWorld, worldObservation, worldToFrame,
  type SimulateOptions, type TraceFighterFrame, type TraceFrame, type TraceResult, type StepResult,
} from "./simulate.js";
export { makeRng, type Rng } from "./rng.js";
export { STRATEGIES, STRATEGY_NAMES, SAMPLE_TRAJECTORIES, type StrategyName } from "./strategies.js";
export { evaluateReciprocalSideBias, type ReciprocalSideBiasOptions, type ReciprocalSideBiasResult } from "./side-bias.js";
