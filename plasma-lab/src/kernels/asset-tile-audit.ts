import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";
import {
  analyzeRgbaTile,
  clampQ,
  decodeRgbaBase64,
  normalizeRgbaTileParams,
  type RgbaTileParams,
} from "./image-tile-common.js";

export const ASSET_TILE_AUDIT_KERNEL_ID = "asset.tile_audit.v0";
export const ASSET_TILE_AUDIT_KERNEL_BINDING = {
  kernelId: ASSET_TILE_AUDIT_KERNEL_ID,
  contract: "asset-tile-audit-v1",
  determinismClass: "bit-exact",
  serialization: "canonical-json-utf8-v1",
  outputSchema: "asset-tile-audit-v1",
};
export const ASSET_TILE_AUDIT_KERNEL_HASH = sha256(canonicalJson(ASSET_TILE_AUDIT_KERNEL_BINDING));

export interface AssetTileAuditParams extends RgbaTileParams {}

export interface AssetTileAuditOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeAssetTileAuditParams(params: Partial<AssetTileAuditParams>): AssetTileAuditParams {
  return normalizeRgbaTileParams(params);
}

export function runAssetTileAuditReference(params: AssetTileAuditParams): AssetTileAuditOutput {
  const spec = normalizeAssetTileAuditParams(params);
  const bytes = decodeRgbaBase64(spec);
  const analysis = analyzeRgbaTile(bytes, spec.width, spec.height);
  const bleedRiskQ = clampQ(
    (analysis.edgeTouchMask !== 0 ? 260 : 0) +
    analysis.fringeAlphaQ * 0.42 +
    Math.max(0, 220 - Math.min(analysis.alphaRect.x0, analysis.alphaRect.y0, spec.width - analysis.alphaRect.x1, spec.height - analysis.alphaRect.y1)) * 2
  );
  const recommendedPadPx = analysis.blank
    ? 0
    : bleedRiskQ >= 700
      ? 2
      : bleedRiskQ >= 380
        ? 1
        : 0;
  const outputBytes = new TextEncoder().encode(canonicalJson({
    kind: ASSET_TILE_AUDIT_KERNEL_ID,
    sourceId: spec.sourceId,
    width: spec.width,
    height: spec.height,
    blank: analysis.blank,
    trimRect: [analysis.alphaRect.x0, analysis.alphaRect.y0, analysis.alphaRect.x1, analysis.alphaRect.y1],
    alphaCoverageQ: analysis.activeCoverageQ,
    fringeAlphaQ: analysis.fringeAlphaQ,
    bleedRiskQ,
    edgeTouchMask: analysis.edgeTouchMask,
    quantizedColorCount: analysis.quantizedColorCount,
    dominantColors: analysis.dominantColors,
    recommendedPadPx,
  }));
  return { outputBytes, outputHash: sha256(outputBytes) };
}
