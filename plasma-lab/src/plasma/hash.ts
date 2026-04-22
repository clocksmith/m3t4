import { createHash, randomBytes } from "node:crypto";
import type { ContentHash } from "./types.js";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256(bytes: Uint8Array | string): ContentHash {
  return { algorithm: "sha256", value: sha256Hex(bytes) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function hashCanonical(value: unknown): ContentHash {
  return sha256(canonicalJson(value));
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

export function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      out[key] = normalize(inner);
    }
    return out;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}
