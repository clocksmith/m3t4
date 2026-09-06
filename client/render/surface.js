export const W = 1280;
export const H = 720;

export function canvasSurfaceSize(cssWidth, deviceDpr = 1) {
  const cssW = Math.max(1, Math.round(cssWidth));
  const cssH = Math.round(cssW * H / W);
  // Pixel art stays on an integer logical grid. A small canvas does not
  // need a full 2560×1440 backing store simply because the phone has high DPR.
  const dpr = Math.max(1, Math.min(2, Math.round(cssW * Math.min(deviceDpr || 1, 2) / W)));
  return { cssW, cssH, dpr, width: W * dpr, height: H * dpr };
}

export function setupCanvasSurface(canvas, { onResize = null } = {}) {
  function resize() {
    const parent = canvas.parentElement;
    const parentW = parent ? parentContentWidth(parent) : Infinity;
    const viewportW = document.documentElement.clientWidth;
    const size = canvasSurfaceSize(Math.min(parentW || viewportW, viewportW), devicePixelRatio);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    canvas.style.width = size.cssW + "px";
    canvas.style.height = size.cssH + "px";
    onResize?.(size);
  }

  window.addEventListener("resize", resize);
  let ro = null;
  if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas.parentElement);
  }
  resize();
  return {
    resize,
    teardown: () => {
      window.removeEventListener("resize", resize);
      ro?.disconnect();
    },
  };
}

export function replaceCanvasElement(canvas) {
  const next = canvas.cloneNode(false);
  next.width = canvas.width;
  next.height = canvas.height;
  next.style.width = canvas.style.width;
  next.style.height = canvas.style.height;
  canvas.replaceWith(next);
  return next;
}

function parentContentWidth(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const px = (value) => Number.parseFloat(value) || 0;
  return Math.max(0,
    rect.width
    - px(style.paddingLeft)
    - px(style.paddingRight)
    - px(style.borderLeftWidth)
    - px(style.borderRightWidth),
  );
}
