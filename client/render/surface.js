export const W = 1280;
export const H = 720;

export function setupCanvasSurface(canvas, { onResize = null } = {}) {
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const parent = canvas.parentElement;
    const parentW = parent ? parentContentWidth(parent) : Infinity;
    const viewportW = document.documentElement.clientWidth - 40;
    const cssW = Math.max(160, Math.min(parentW || viewportW, viewportW));
    const cssH = cssW * (H / W);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = Math.round(cssW) + "px";
    canvas.style.height = Math.round(cssH) + "px";
    onResize?.({ dpr, width: canvas.width, height: canvas.height, cssW, cssH });
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
