// Erase the Gemini four-pointed-sparkle AI watermark from the bottom-right
// corner of a raw generation by replacing the sparkle bbox with pixels
// copied from the same-size region immediately to its left.
//
// The watermark is always in the same relative position on a Gemini
// output and is mostly-uniform light gray. Surrounding pixels are usually
// a usable source; this is not true content-aware inpainting, but it
// produces a clean result when the content in the bottom-right corner is
// reasonably horizontally continuous (almost always true for atlases).

const DEFAULT = {
  // Fractional bbox from the bottom-right corner.
  boxWFrac: 0.085,   // ~8.5% of image width
  boxHFrac: 0.05,    // ~5% of image height
  insetXFrac: 0.005, // ~0.5% inset from right edge
  insetYFrac: 0.005, // ~0.5% inset from bottom edge
  minBoxW: 96,
  minBoxH: 80,
};

export function eraseBottomRightSparkle(img, opts = {}) {
  const cfg = { ...DEFAULT, ...opts };
  const { width: w, height: h, data } = img;
  const boxW = Math.max(cfg.minBoxW, Math.round(w * cfg.boxWFrac));
  const boxH = Math.max(cfg.minBoxH, Math.round(h * cfg.boxHFrac));
  const insetX = Math.round(w * cfg.insetXFrac);
  const insetY = Math.round(h * cfg.insetYFrac);
  const x0 = w - boxW - insetX;
  const y0 = h - boxH - insetY;
  const srcDx = -boxW;
  if (x0 + srcDx < 0) throw new Error("source region falls off left edge");
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const dstI = ((y0 + y) * w + (x0 + x)) * 4;
      const srcI = ((y0 + y) * w + (x0 + x + srcDx)) * 4;
      data[dstI]     = data[srcI];
      data[dstI + 1] = data[srcI + 1];
      data[dstI + 2] = data[srcI + 2];
      data[dstI + 3] = data[srcI + 3];
    }
  }
  return { x: x0, y: y0, width: boxW, height: boxH };
}
