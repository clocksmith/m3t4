// Normalized mode lifecycle for the hash router.
// Existing modes can keep exporting mount/unmount; this helper makes the
// router treat every route consistently and gives new modes one small shape.

export function defineMode(spec) {
  if (!spec || typeof spec.mount !== "function") {
    throw new Error("mode must export mount(root, context)");
  }
  if (spec.__m3t4Mode) return spec;

  return {
    __m3t4Mode: true,
    mount(root, context = {}) {
      return spec.mount(root, context);
    },
    unmount() {
      if (typeof spec.unmount === "function") spec.unmount();
    },
  };
}
