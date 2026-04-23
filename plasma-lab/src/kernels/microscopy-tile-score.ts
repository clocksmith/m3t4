import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";
import {
  analyzeRgbaTile,
  clampQ,
  decodeRgbaBase64,
  normalizeRgbaTileParams,
  type RgbaTileParams,
} from "./image-tile-common.js";

export const MICROSCOPY_TILE_SCORE_KERNEL_ID = "science.microscopy_tile_score.v0";
export const MICROSCOPY_TILE_SCORE_KERNEL_BINDING = {
  kernelId: MICROSCOPY_TILE_SCORE_KERNEL_ID,
  contract: "microscopy-tile-heuristic-score-v1",
  determinismClass: "bit-exact",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "microscopy-scorecard-v1",
};
export const MICROSCOPY_TILE_SCORE_KERNEL_HASH = sha256(canonicalJson(MICROSCOPY_TILE_SCORE_KERNEL_BINDING));

export interface MicroscopyTileScoreParams extends RgbaTileParams {}

export interface MicroscopyTileScoreOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeMicroscopyTileScoreParams(params: Partial<MicroscopyTileScoreParams>): MicroscopyTileScoreParams {
  return normalizeRgbaTileParams(params);
}

export function runMicroscopyTileScoreReference(params: MicroscopyTileScoreParams): MicroscopyTileScoreOutput {
  const spec = normalizeMicroscopyTileScoreParams(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const focusQ = clampQ(analysis.edgeDensityQ * 0.5 + analysis.contrastQ * 0.25 + analysis.granularityQ * 0.25);
  const cellularityQ = clampQ(
    analysis.purpleDensityQ * 0.38 +
    analysis.darkDensityQ * 0.24 +
    analysis.granularityQ * 0.18 +
    analysis.activeCoverageQ * 0.1 +
    analysis.pinkDensityQ * 0.1
  );
  const stainBalanceQ = clampQ(1000 - Math.abs(analysis.purpleDensityQ - analysis.pinkDensityQ));
  const artifactQ = clampQ(
    (analysis.edgeTouchMask !== 0 ? 220 : 0) +
    analysis.fringeAlphaQ * 0.32 +
    (1000 - focusQ) * 0.16 +
    Math.max(0, analysis.saturationQ - 760) * 0.18 +
    Math.max(0, Math.abs(analysis.activeCoverageQ - 820) - 120) * 0.2
  );
  const anomalyQ = clampQ(artifactQ * 0.36 + Math.max(0, cellularityQ - 680) * 0.28 + (1000 - stainBalanceQ) * 0.2 + (1000 - focusQ) * 0.16);
  const label = artifactQ >= 620
    ? "artifact-heavy"
    : cellularityQ >= 620
      ? "cell-dense"
      : cellularityQ <= 260
        ? "sparse-field"
        : "mixed-field";
  const outputBytes = new TextEncoder().encode(canonicalJson({
    kind: MICROSCOPY_TILE_SCORE_KERNEL_ID,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    label,
    alphaRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    scoreQ: {
      focusQ,
      cellularityQ,
      stainBalanceQ,
      artifactQ,
      anomalyQ,
      purpleDensityQ: analysis.purpleDensityQ,
      pinkDensityQ: analysis.pinkDensityQ,
      darkDensityQ: analysis.darkDensityQ,
      granularityQ: analysis.granularityQ,
    },
  }));
  return { outputBytes, outputHash: sha256(outputBytes) };
}
