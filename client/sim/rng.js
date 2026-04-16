// Mulberry32 — deterministic 32-bit RNG. Same seed → same stream, on every
// JS engine. The ONLY source of randomness used by the simulator.
export function makeRng(seed) {
    let a = (seed | 0) || 1;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function rngRange(rng, lo, hi) {
    return lo + (hi - lo) * rng();
}
