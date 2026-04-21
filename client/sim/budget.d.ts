import type { BrainConfig, ParamKey } from "./types.js";
export declare const USER_BUDGET = 360;
export declare const HALLUCINATION_PER_OVERAGE = 10;
export declare const MIN_CLEAN_SPEND = 180;
export declare const HALLUCINATION_PER_UNDERSPEND = 3;
export declare const MAX_DERIVED_HALLUCINATION = 300;
export declare const MAX_USER_SPEND: number;
export declare const USER_SUBMISSION_EPSILON = 0.000001;
export declare const USER_KNOBS: ParamKey[];
export declare const RANGES: Record<ParamKey, [number, number]>;
export declare function nativeToUI(k: ParamKey, nativeVal: number): number;
export declare function uiToNative(k: ParamKey, ui: number): number;
export declare function budgetSpent(cfg: Pick<BrainConfig, "attributes">): number;
export declare function computedHallucinationForSpend(spent: number): number;
export declare function computedHallucination(cfg: Pick<BrainConfig, "attributes">): number;
export interface UserSubmissionValidation {
    ok: boolean;
    errors: string[];
    spent: number;
    hallucination: number;
    config?: BrainConfig;
}
export declare function validateUserSubmission(cfg: BrainConfig): UserSubmissionValidation;
export declare function isWithinBudget(cfg: BrainConfig): boolean;
