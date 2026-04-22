export const DEFAULT_ROUTE = "intro";

export const DEFAULT_FEATURES = {
  p2pDuel: false,
  communityVerify: false,
  proofLab: false,
  zk: false,
  distributedCompute: false,
  computeSlackWorker: false,
  computeWebRtcArtifacts: false,
  computeReceiptDashboard: false,
  computeLiveBadges: false,
  webgpuRenderer: false,
  webglRenderer: false,
};

export const LEGACY_HASH = {
  practice: "build",
  lore: "intro",
  rules: "about",
};

const ROUTE_FEATURES = {
  duel: "p2pDuel",
};

export function featureForRoute(route) {
  return ROUTE_FEATURES[route] ?? null;
}
