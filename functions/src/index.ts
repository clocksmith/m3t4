// Firebase Functions entry point. Exports each function so
// `firebase deploy --only functions` deploys the full set.

export { matchTick } from "./matchTick.js";
export { matchTickWatchdog } from "./matchTickWatchdog.js";
export { bootstrapMatch } from "./bootstrapMatch.js";
export { submitStable } from "./submitStable.js";
export { webrtcSignal } from "./webrtcSignal.js";
