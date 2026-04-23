import { canonicalJson, hashCanonical, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const LOGIT_DIVERGENCE_KERNEL_ID = "ml.logit_divergence.v0";
export const LOGIT_DIVERGENCE_MODEL_ID = "gemma-3-270m-it-q4k-ehf16-af32";
export const LOGIT_DIVERGENCE_LOGIT_SCALE = 256;
export const LOGIT_DIVERGENCE_KERNEL_BINDING = {
  kernelId: LOGIT_DIVERGENCE_KERNEL_ID,
  modelId: LOGIT_DIVERGENCE_MODEL_ID,
  contract: "prefill-topk-logit-buckets-v1",
  determinismClass: "tolerance-bounded",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "prefill-topk-logit-buckets-v1",
  logitScale: LOGIT_DIVERGENCE_LOGIT_SCALE,
};
export const LOGIT_DIVERGENCE_KERNEL_HASH = sha256(canonicalJson(LOGIT_DIVERGENCE_KERNEL_BINDING));

export interface LogitDivergenceParams {
  modelId: string;
  promptText: string;
  topK: number;
}

export interface LogitDivergenceHit {
  rank: number;
  tokenId: number;
  logitQ: number;
  deltaTopQ: number;
}

export interface LogitDivergencePublicOutput {
  kind: typeof LOGIT_DIVERGENCE_KERNEL_ID;
  modelId: string;
  promptHash: string;
  promptLength: number;
  prefillTokenCount: number;
  topK: number;
  logitScale: number;
  hits: LogitDivergenceHit[];
}

export function normalizeLogitDivergenceParams(params: Partial<LogitDivergenceParams>): LogitDivergenceParams {
  const modelId = String(params.modelId ?? LOGIT_DIVERGENCE_MODEL_ID).trim();
  if (modelId !== LOGIT_DIVERGENCE_MODEL_ID) {
    throw new Error(`unsupported logit divergence model: ${modelId}`);
  }
  const promptText = normalizeText(params.promptText, "promptText", 1, 1024);
  const topK = asInt(params.topK ?? 4, "topK");
  if (topK < 1 || topK > 8) throw new Error("topK must be 1..8");
  return { modelId, promptText, topK };
}

export function logitDivergencePlaceholderOutputHash(params: LogitDivergenceParams): ContentHash {
  return hashCanonical({
    kind: LOGIT_DIVERGENCE_KERNEL_ID,
    modelId: params.modelId,
    promptText: params.promptText,
    topK: params.topK,
    validation: "measurement-placeholder-v1",
  });
}

export function normalizeLogitDivergencePublicOutput(
  value: unknown,
  params?: Partial<LogitDivergenceParams>,
): LogitDivergencePublicOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("logit divergence publicOutput must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== LOGIT_DIVERGENCE_KERNEL_ID) {
    throw new Error("logit divergence publicOutput kind invalid");
  }
  const modelId = String(raw.modelId ?? "").trim();
  if (modelId !== LOGIT_DIVERGENCE_MODEL_ID) {
    throw new Error("logit divergence publicOutput modelId invalid");
  }
  if (params?.modelId && modelId !== params.modelId) {
    throw new Error("logit divergence publicOutput modelId mismatch");
  }
  const promptHash = normalizeHexHash(raw.promptHash, "promptHash");
  const promptLength = asInt(raw.promptLength, "promptLength");
  if (params?.promptText && promptLength !== params.promptText.length) {
    throw new Error("logit divergence publicOutput promptLength mismatch");
  }
  const prefillTokenCount = asInt(raw.prefillTokenCount, "prefillTokenCount");
  if (prefillTokenCount < 1 || prefillTokenCount > 4096) {
    throw new Error("logit divergence publicOutput prefillTokenCount invalid");
  }
  const topK = asInt(raw.topK, "topK");
  if (topK < 1 || topK > 8) throw new Error("logit divergence publicOutput topK invalid");
  if (params?.topK && topK !== params.topK) {
    throw new Error("logit divergence publicOutput topK mismatch");
  }
  const logitScale = asInt(raw.logitScale, "logitScale");
  if (logitScale !== LOGIT_DIVERGENCE_LOGIT_SCALE) {
    throw new Error("logit divergence publicOutput logitScale invalid");
  }
  const hitsRaw = raw.hits;
  if (!Array.isArray(hitsRaw) || hitsRaw.length !== topK) {
    throw new Error("logit divergence publicOutput hits invalid");
  }
  const hits = hitsRaw.map((entry, index) => normalizeLogitDivergenceHit(entry, index + 1));
  const seenTokenIds = new Set<number>();
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit.rank !== i + 1) throw new Error("logit divergence hit rank invalid");
    if (seenTokenIds.has(hit.tokenId)) throw new Error("logit divergence hit tokenId duplicated");
    seenTokenIds.add(hit.tokenId);
    if (i === 0 && hit.deltaTopQ !== 0) throw new Error("logit divergence top hit delta must be 0");
    if (hit.deltaTopQ > 0) throw new Error("logit divergence hit deltaTopQ invalid");
  }
  return {
    kind: LOGIT_DIVERGENCE_KERNEL_ID,
    modelId,
    promptHash,
    promptLength,
    prefillTokenCount,
    topK,
    logitScale,
    hits,
  };
}

export function logitDivergencePublicOutputHash(output: LogitDivergencePublicOutput): ContentHash {
  return hashCanonical(output);
}

function normalizeLogitDivergenceHit(value: unknown, expectedRank: number): LogitDivergenceHit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("logit divergence hit must be an object");
  }
  const raw = value as Record<string, unknown>;
  const rank = asInt(raw.rank, "rank");
  if (rank !== expectedRank) throw new Error("logit divergence hit rank invalid");
  const tokenId = asInt(raw.tokenId, "tokenId");
  const logitQ = asSignedInt(raw.logitQ, "logitQ");
  const deltaTopQ = asSignedInt(raw.deltaTopQ, "deltaTopQ");
  return { rank, tokenId, logitQ, deltaTopQ };
}

function normalizeText(value: unknown, label: string, min: number, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}..${max} chars`);
  }
  return text;
}

function normalizeHexHash(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`invalid ${label}`);
  return text;
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) throw new Error(`invalid ${label}`);
  return n;
}

function asSignedInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < -(2 ** 31) || n > 2 ** 31 - 1) throw new Error(`invalid ${label}`);
  return n;
}
