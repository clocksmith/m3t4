import type { BrainConfig } from "./types.js";
export declare const STRATEGY_NAMES: readonly ["standby", "blitz", "incumbent", "pivot", "thesis", "disruptor", "operator", "oracle", "shipper", "moonshot", "regulatory", "founder", "acolyte", "unicorn", "troll", "acquirer"];
export type StrategyName = (typeof STRATEGY_NAMES)[number];
export declare const STRATEGIES: Record<StrategyName, BrainConfig>;
export declare const SAMPLE_TRAJECTORIES: BrainConfig[];
