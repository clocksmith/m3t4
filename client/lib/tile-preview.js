// Shared helper for turning a Uint32Array tile into an advisory PNG
// preview attached to a receipt. The preview is never part of the receipt
// acceptance contract — output bytes still govern via outputHash. This
// module exists so every tile-shaped kernel (contact-map, mandelbrot,
// heat, gray-scott, …) emits previews in the same shape.
//
//   buildTilePreview({ outputU32, widthPx, heightPx, colormap? })
//     → { encoding: "png", widthPx, heightPx, sha256, bytesBase64 }
//     → null when OffscreenCanvas / crypto.subtle is unavailable or the
//       PNG would exceed the server-side 4KB cap.

const MAX_PNG_BYTES = 4096;

// Viridis-approximation LUT. 16 stops, linearly interpolated. Accurate
// enough for small thumbnails; avoids shipping a 256-entry table.
const VIRIDIS_STOPS = [
  [68, 1, 84], [72, 34, 115], [64, 67, 135], [52, 94, 141],
  [41, 120, 142], [32, 144, 140], [34, 167, 132], [68, 190, 112],
  [121, 209, 81], [189, 222, 38], [253, 231, 36], [253, 204, 25],
  [240, 153, 36], [208, 98, 42], [155, 43, 32], [89, 1, 56],
];

function viridisLookup(t) {
  const x = Math.max(0, Math.min(1, t));
  const seg = x * (VIRIDIS_STOPS.length - 1);
  const lo = Math.floor(seg);
  const hi = Math.min(VIRIDIS_STOPS.length - 1, lo + 1);
  const f = seg - lo;
  const a = VIRIDIS_STOPS[lo];
  const b = VIRIDIS_STOPS[hi];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function normalizeToFloat(outputU32) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of outputU32) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const out = new Float32Array(outputU32.length);
  for (let i = 0; i < outputU32.length; i++) {
    out[i] = (outputU32[i] - lo) / range;
  }
  return out;
}

function encodeRgba(outputU32, widthPx, heightPx, colormap) {
  const floats = normalizeToFloat(outputU32);
  const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let i = 0; i < widthPx * heightPx; i++) {
    const [r, g, b] = colormap === "grayscale"
      ? (() => { const g = Math.round(floats[i] * 255); return [g, g, g]; })()
      : viridisLookup(floats[i]);
    rgba[i * 4 + 0] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function buildTilePreview({ outputU32, widthPx, heightPx, colormap = "viridis" }) {
  if (typeof OffscreenCanvas === "undefined") return null;
  if (!crypto?.subtle?.digest) return null;
  if (!Number.isInteger(widthPx) || widthPx <= 0) return null;
  if (!Number.isInteger(heightPx) || heightPx <= 0) return null;
  if (!outputU32 || outputU32.length !== widthPx * heightPx) return null;
  try {
    const canvas = new OffscreenCanvas(widthPx, heightPx);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const rgba = encodeRgba(outputU32, widthPx, heightPx, colormap);
    const imageData = new ImageData(rgba, widthPx, heightPx);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.length > MAX_PNG_BYTES) return null;
    const sha256 = await sha256Hex(bytes);
    return {
      encoding: "png",
      widthPx,
      heightPx,
      sha256,
      bytesBase64: bytesToBase64(bytes),
    };
  } catch {
    return null;
  }
}
