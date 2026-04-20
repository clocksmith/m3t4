// ============ Brain params (static shape) ============
export const PARAM_KEYS = [
    "burnRate",
    "moat",
    "shipRate",
    "foresight",
    "pivotSpeed",
    "leverage",
    "networking",
    // ---- expansion: 4 new axes that interact with the originals ----
    "spite", // -1..+1: prioritize own delivery (+) vs denying opp's (-)
    "greed", //  0..1:  how hard to push through danger to deliver
    "pacing", //  0..1:  rhythmic burst pattern on burnRate
    "cunning", //  0..1:  swing timing — patient counter vs reckless
    // -------------------------------------------------------------
    "hallucination",
];
export const DEFAULT_PARAMS = {
    burnRate: 0.5,
    moat: 90,
    shipRate: 0.7,
    foresight: 0.05,
    pivotSpeed: 0.5,
    leverage: 0.0,
    networking: 0.0,
    spite: 0.0,
    greed: 0.5,
    pacing: 0.0,
    cunning: 0.5,
    hallucination: 0,
};
function emptyModeRecord() {
    return { neutral: 0, offense: 0, zone: 0, objective: 0, escape: 0 };
}
export function emptyFighterTelemetry() {
    return {
        modeTicks: emptyModeRecord(),
        substateTicks: { press: 0, bait: 0, punish: 0, deliver: 0, intercept: 0, pickup: 0 },
        modeSwitches: 0,
        zoneEntries: 0,
        objectiveEntries: 0,
        escapeEntries: 0,
        swipes: 0,
        dives: 0,
        kills: 0,
        deaths: 0,
        clashes: 0,
        deliveries: 0,
        ticks: 0,
        modeSwipes: emptyModeRecord(),
        modeDives: emptyModeRecord(),
        modeClashes: emptyModeRecord(),
    };
}
