import type { AttributeSpec, Observation, Params, ParamKey } from "./types.js";
export interface EvalCtx {
    tick: number;
    obs: Observation;
}
export type AttributeEvaluator = (ctx: EvalCtx) => number;
export declare function compileAttribute(spec: AttributeSpec | undefined, fallback: number): AttributeEvaluator;
export interface CompiledBrain {
    id: string;
    author?: string;
    evaluators: Record<ParamKey, AttributeEvaluator>;
}
export declare function compileBrain(cfg: {
    id: string;
    author?: string;
    attributes: Partial<Record<ParamKey, AttributeSpec>>;
}): CompiledBrain;
export declare function evaluateParams(brain: CompiledBrain, obs: Observation): Params;
