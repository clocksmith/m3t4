import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";
import {
  analyzeRgbaTile,
  asInt,
  clampQ,
  decodeRgbaBase64,
  normalizeRgbaTileParams,
  type RgbaTileParams,
} from "./image-tile-common.js";

export const IMAGE_TILE_INFER_KERNEL_ID = "ml.image_tile_infer.v0";
export const IMAGE_TILE_INFER_MODEL_ID = "tile-linear-v1";
export const IMAGE_TILE_INFER_KERNEL_BINDING = {
  kernelId: IMAGE_TILE_INFER_KERNEL_ID,
  modelId: IMAGE_TILE_INFER_MODEL_ID,
  contract: "fixed-linear-image-tile-classifier-v1",
  determinismClass: "bit-exact",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "image-tile-topk-labels-v1",
};
export const IMAGE_TILE_INFER_KERNEL_HASH = sha256(canonicalJson(IMAGE_TILE_INFER_KERNEL_BINDING));

export interface ImageTileInferParams extends RgbaTileParams {
  topK: number;
}

export interface ImageTileInferOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

const LABELS = ["sprite", "ui", "terrain", "text", "effect", "portrait", "other"] as const;

export function normalizeImageTileInferParams(params: Partial<ImageTileInferParams>): ImageTileInferParams {
  const tile = normalizeRgbaTileParams(params);
  const topK = asInt(params.topK ?? 3, "topK");
  if (topK < 1 || topK > 4) throw new Error("topK must be 1..4");
  return { ...tile, topK };
}

export function runImageTileInferReference(params: ImageTileInferParams): ImageTileInferOutput {
  const spec = normalizeImageTileInferParams(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const midCoverageQ = 1000 - Math.min(1000, Math.abs(analysis.activeCoverageQ - 520) * 2);
  const edgeTouchPenalty = analysis.edgeTouchMask === 0 ? 0 : 80;
  const scoreMap: Record<(typeof LABELS)[number], number> = {
    sprite: clampQ(
      120 +
      midCoverageQ * 0.34 +
      analysis.saturationQ * 0.24 +
      analysis.contrastQ * 0.18 +
      analysis.symmetryQ * 0.12 -
      analysis.textStrokeQ * 0.12 -
      edgeTouchPenalty
    ),
    ui: clampQ(
      120 +
      analysis.textStrokeQ * 0.32 +
      analysis.flatnessQ * 0.28 +
      analysis.edgeDensityQ * 0.18 +
      (analysis.edgeTouchMask !== 0 ? 120 : 20) +
      (analysis.activeCoverageQ > 760 ? 80 : 0) -
      analysis.saturationQ * 0.08
    ),
    terrain: clampQ(
      120 +
      analysis.activeCoverageQ * 0.22 +
      analysis.entropyQ * 0.28 +
      analysis.edgeDensityQ * 0.16 +
      (analysis.edgeTouchMask !== 0 ? 70 : 0) -
      analysis.symmetryQ * 0.1
    ),
    text: clampQ(
      110 +
      analysis.textStrokeQ * 0.42 +
      analysis.contrastQ * 0.24 +
      analysis.flatnessQ * 0.16 +
      (analysis.activeCoverageQ < 720 ? 90 : 0) -
      analysis.saturationQ * 0.14
    ),
    effect: clampQ(
      110 +
      (1000 - analysis.activeCoverageQ) * 0.24 +
      analysis.saturationQ * 0.36 +
      analysis.contrastQ * 0.18 +
      Math.max(analysis.warmRatioQ, analysis.coolRatioQ) * 0.12
    ),
    portrait: clampQ(
      100 +
      analysis.warmRatioQ * 0.26 +
      analysis.symmetryQ * 0.24 +
      midCoverageQ * 0.16 +
      (analysis.activeCoverageQ > 220 && analysis.activeCoverageQ < 940 ? 90 : 0)
    ),
    other: clampQ(
      100 +
      analysis.entropyQ * 0.12 +
      analysis.saturationQ * 0.12 +
      analysis.contrastQ * 0.1
    ),
  };
  const topLabels = LABELS.map((label) => ({ label, scoreQ: scoreMap[label] }))
    .sort((a, b) => b.scoreQ - a.scoreQ || a.label.localeCompare(b.label))
    .slice(0, spec.topK);
  const outputBytes = new TextEncoder().encode(canonicalJson({
    kind: IMAGE_TILE_INFER_KERNEL_ID,
    modelId: IMAGE_TILE_INFER_MODEL_ID,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    topK: spec.topK,
    alphaRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    featureQ: {
      activeCoverageQ: analysis.activeCoverageQ,
      edgeDensityQ: analysis.edgeDensityQ,
      contrastQ: analysis.contrastQ,
      saturationQ: analysis.saturationQ,
      textStrokeQ: analysis.textStrokeQ,
      symmetryQ: analysis.symmetryQ,
      warmRatioQ: analysis.warmRatioQ,
      coolRatioQ: analysis.coolRatioQ,
      flatnessQ: analysis.flatnessQ,
    },
    topLabels,
  }));
  return { outputBytes, outputHash: sha256(outputBytes) };
}
