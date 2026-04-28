// Public API for @m3t4/match-engine: deterministic match selection,
// simulation, packaging, and ELO update. Used by Firebase Functions
// (server side) and exported types are safe for client import.

export { expected, updatePair } from "./elo.js";
export {
  selectPair,
  rankedSideSwap,
  type StableSummary,
  type SelectPairOptions,
  type SelectedPair,
} from "./pair-selection.js";
export {
  runMatch,
  type RunMatchInput,
  type RunMatchOutput,
  type MatchDocV1,
} from "./match-runner.js";
