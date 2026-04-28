// Firebase Functions entry point. Exports each function so
// `firebase deploy --only functions` deploys the full set.

export { matchTick } from "./matchTick.js";
export { matchTickWatchdog } from "./matchTickWatchdog.js";
export { bootstrapMatch } from "./bootstrapMatch.js";
export { claimHandle } from "./claimHandle.js";
export {
  computeRegister,
  computeClaim,
  computeSubmitReceipt,
  computeMyReceipts,
  computePublicSummary,
} from "./compute.js";
export { submitStable } from "./submitStable.js";
export { webrtcSignal } from "./webrtcSignal.js";
export { expireSessions } from "./expireSessions.js";
