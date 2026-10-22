import type { Stage } from "./types.js";
export declare const STAGE_DATACENTER: Stage;
export declare const STAGE_BOARDROOM: Stage;
export declare const STAGE_DEMODAY: Stage;
export declare const STAGES: {
    readonly datacenter: Stage;
    readonly boardroom: Stage;
    readonly demoday: Stage;
};
export type StageId = keyof typeof STAGES;
