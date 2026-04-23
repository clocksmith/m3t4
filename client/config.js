// Public production client config. Firebase web config values are public
// identifiers; do not put server secrets here.
const isLocalM3t4Config = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.__M3T4_API_ORIGIN__ = isLocalM3t4Config ? "http://localhost:7777" : window.location.origin;
window.__M3T4_WS_ORIGIN__ = isLocalM3t4Config
  ? "ws://localhost:7777"
  : "wss://arena-server-789525635095.us-central1.run.app";
window.__M3T4_AUTH_MODE__ = isLocalM3t4Config ? "dev" : "firebase";
window.__M3T4_COMPUTE_SLACK_WORKER__ = true;
window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = true;
window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__ = true;
window.__M3T4_COMPUTE_EMBED_TILE__ = false;
window.__M3T4_COMPUTE_PREFILL_TOPK_PROBE__ = false;
window.__M3T4_COMPUTE_LOGIT_DIVERGENCE__ = true;
window.__M3T4_COMPUTE_GENOME_KMER__ = true;
window.__M3T4_COMPUTE_EMBED_MODEL__ = "";
window.__M3T4_COMPUTE_LAB_ORIGIN__ = "https://plasma-lab-789525635095.us-central1.run.app";
window.__M3T4_COMPUTE_STUN_URLS__ = ["stun:stun.l.google.com:19302"];
window.__M3T4_COMPUTE_ICE_SERVERS__ = [];
window.__M3T4_FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyDFA7zBgdul_VMRf3YnOJgj2B8qHE-JBbI",
  authDomain: "m3ta-ai.firebaseapp.com",
  projectId: "m3ta-ai",
  storageBucket: "m3ta-ai.firebasestorage.app",
  messagingSenderId: "789525635095",
  appId: "1:789525635095:web:be4cb0f8394c73c680bc52",
  measurementId: "G-7DQNL6QVQX",
};
