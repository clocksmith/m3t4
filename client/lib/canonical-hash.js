// Canonical JSON + sha256 matching plasma-lab/src/plasma/hash.ts so
// client-side hash verification produces the same ContentHash the server
// emits. Keep these two implementations aligned — divergence silently
// breaks hash-verified P2P distribution.

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, inner] of entries) out[key] = normalize(inner);
    return out;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

export async function sha256Hex(bytesOrText) {
  const data = typeof bytesOrText === "string"
    ? new TextEncoder().encode(bytesOrText)
    : bytesOrText;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashCanonical(value) {
  return { algorithm: "sha256", value: await sha256Hex(canonicalJson(value)) };
}

export function hashesEqual(a, b) {
  return Boolean(a) && Boolean(b) && a.algorithm === b.algorithm && a.value === b.value;
}
