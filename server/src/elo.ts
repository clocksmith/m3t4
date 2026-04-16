// ELO math. Uses K=16 on per-slot ratings. Called from the matchmaker
// after each match completes.

import { CONFIG } from "./config.js";

export function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function updatePair(
  a: number,
  b: number,
  winner: 0 | 1 | -1,
): { a: number; b: number } {
  const ea = expected(a, b);
  const sa = winner === 0 ? 1 : winner === 1 ? 0 : 0.5;
  const sb = 1 - sa;
  return {
    a: Math.round(a + CONFIG.eloK * (sa - ea)),
    b: Math.round(b + CONFIG.eloK * (sb - (1 - ea))),
  };
}
