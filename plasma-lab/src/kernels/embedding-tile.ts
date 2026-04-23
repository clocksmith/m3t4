import { canonicalJson, hashCanonical, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const EMBEDDING_TILE_KERNEL_ID = "ml.embedding_tile.v0";
export const EMBEDDING_TILE_MODEL_ID = "google-embeddinggemma-300m-q4k-ehf16-af32";
export const EMBEDDING_TILE_KERNEL_BINDING = {
  kernelId: EMBEDDING_TILE_KERNEL_ID,
  modelId: EMBEDDING_TILE_MODEL_ID,
  contract: "embedding-rerank-quantized-v1",
  determinismClass: "replicated-quorum",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "embedding-topk-qscore-v1",
  scoreScale: 1000,
};
export const EMBEDDING_TILE_KERNEL_HASH = sha256(canonicalJson(EMBEDDING_TILE_KERNEL_BINDING));

export interface EmbeddingTileParams {
  modelId: string;
  queryText: string;
  documentsJson: string;
  topK: number;
}

export interface EmbeddingTileTaskOutput {
  placeholderOutputHash: ContentHash;
}

export function normalizeEmbeddingTileParams(params: Partial<EmbeddingTileParams>): EmbeddingTileParams {
  const modelId = String(params.modelId ?? EMBEDDING_TILE_MODEL_ID).trim();
  if (modelId !== EMBEDDING_TILE_MODEL_ID) {
    throw new Error(`unsupported embedding model: ${modelId}`);
  }
  const queryText = normalizeText(params.queryText, "queryText", 1, 2048);
  const documentsJson = typeof params.documentsJson === "string" ? params.documentsJson : "";
  if (!documentsJson) throw new Error("documentsJson required");
  if (documentsJson.length > 16 * 1024) throw new Error("documentsJson too large");
  const documents = parseDocuments(documentsJson);
  if (documents.length < 1 || documents.length > 16) throw new Error("embedding tile requires 1..16 documents");
  for (const doc of documents) normalizeText(doc, "document", 1, 2048);
  const topK = asInt(params.topK ?? 4, "topK");
  if (topK < 1 || topK > Math.min(8, documents.length)) {
    throw new Error("topK must be 1..min(8, documents.length)");
  }
  return { modelId, queryText, documentsJson: canonicalJson(documents), topK };
}

export function embeddingTilePlaceholderOutputHash(params: EmbeddingTileParams): ContentHash {
  return hashCanonical({
    kind: EMBEDDING_TILE_KERNEL_ID,
    modelId: params.modelId,
    queryText: params.queryText,
    documentsJson: params.documentsJson,
    topK: params.topK,
    validation: "replicated-quorum-placeholder-v1",
  });
}

function parseDocuments(documentsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentsJson);
  } catch {
    throw new Error("documentsJson must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("documentsJson must be a string array");
  return parsed.map((value) => {
    if (typeof value !== "string") throw new Error("documentsJson entries must be strings");
    return value;
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
