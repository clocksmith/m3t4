import { canonicalJson, hashCanonical, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const PREFILL_TOPK_PROBE_KERNEL_ID = "ml.prefill_topk_probe.v0";
export const PREFILL_TOPK_PROBE_MODEL_ID = "gemma-3-270m-it-q4k-ehf16-af32";
export const PREFILL_TOPK_PROBE_KERNEL_BINDING = {
  kernelId: PREFILL_TOPK_PROBE_KERNEL_ID,
  modelId: PREFILL_TOPK_PROBE_MODEL_ID,
  contract: "prefill-topk-token-ids-v1",
  determinismClass: "replicated-quorum",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "prefill-topk-token-ids-v1",
};
export const PREFILL_TOPK_PROBE_KERNEL_HASH = sha256(canonicalJson(PREFILL_TOPK_PROBE_KERNEL_BINDING));

export interface PrefillTopkProbeParams {
  modelId: string;
  promptText: string;
  topK: number;
}

export function normalizePrefillTopkProbeParams(params: Partial<PrefillTopkProbeParams>): PrefillTopkProbeParams {
  const modelId = String(params.modelId ?? PREFILL_TOPK_PROBE_MODEL_ID).trim();
  if (modelId !== PREFILL_TOPK_PROBE_MODEL_ID) {
    throw new Error(`unsupported prefill probe model: ${modelId}`);
  }
  const promptText = normalizeText(params.promptText, "promptText", 1, 1024);
  const topK = asInt(params.topK ?? 4, "topK");
  if (topK < 1 || topK > 8) throw new Error("topK must be 1..8");
  return { modelId, promptText, topK };
}

export function prefillTopkProbePlaceholderOutputHash(params: PrefillTopkProbeParams): ContentHash {
  return hashCanonical({
    kind: PREFILL_TOPK_PROBE_KERNEL_ID,
    modelId: params.modelId,
    promptText: params.promptText,
    topK: params.topK,
    validation: "replicated-quorum-placeholder-v1",
  });
}

function normalizeText(value: unknown, label: string, min: number, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}..${max} chars`);
  }
  return text;
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) throw new Error(`invalid ${label}`);
  return n;
}
