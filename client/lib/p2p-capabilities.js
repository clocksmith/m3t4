// Configuration/capability check only; pairing and service health are checked
// when starting a session. Local play must not download the signaling SDK.
export function isP2PSupported() {
  return typeof window !== "undefined"
    && typeof RTCPeerConnection !== "undefined"
    && Boolean(window.__M3T4_FIREBASE_CONFIG__ ?? window.__M3T4_FIREBASE__);
}
