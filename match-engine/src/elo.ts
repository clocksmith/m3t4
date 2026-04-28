// ELO math for ranked matches. K-factor 16 by default (configurable).

export function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function updatePair(
  a: number,
  b: number,
  winner: 0 | 1 | -1,
  kFactor = 16,
): { a: number; b: number } {
  const ea = expected(a, b);
  const sa = winner === 0 ? 1 : winner === 1 ? 0 : 0.5;
  const sb = 1 - sa;
  return {
    a: Math.round(a + kFactor * (sa - ea)),
    b: Math.round(b + kFactor * (sb - (1 - ea))),
  };
}
