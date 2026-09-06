// Requested on first draw, cached for the renderer's lifetime. Sprite sheets
// remain lossless PNG; stage layers can prefer their existing WebP derivative.
export function imageState(url, fallbackUrl = null) {
  return { url, fallbackUrl, image: null, loaded: false, failed: false };
}

export function loadImage(state) {
  if (state.failed) return null;
  if (state.loaded) return state.image;
  if (!state.image && typeof Image !== "undefined") {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { state.loaded = true; };
    let fallbackUsed = false;
    img.onerror = () => {
      if (state.fallbackUrl && !fallbackUsed) {
        fallbackUsed = true;
        img.src = state.fallbackUrl;
      } else state.failed = true;
    };
    state.image = img;
    img.src = state.url;
  }
  return state.loaded ? state.image : null;
}
