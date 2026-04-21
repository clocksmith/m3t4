// Copy to client/config.js during deploy. Firebase web config values are
// public identifiers; do not put server secrets here.

// Production can use same-origin Firebase Hosting rewrites for REST /api.
// WebSockets should use a Cloud Run/custom API host; Hosting rewrites do
// not reliably proxy WebSocket upgrades.
window.__M3T4_API_ORIGIN__ = window.location.origin;
window.__M3T4_WS_ORIGIN__ = window.__M3T4_API_ORIGIN__.replace(/^http/, "ws");
window.__M3T4_AUTH_MODE__ = "firebase";
window.__M3T4_FIREBASE_CONFIG__ = {
  apiKey: "",
  authDomain: "m3t4.ai",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// Closed alpha only. This is a convenience gate for the static app, not a
// substitute for server-side auth.
// window.__M3T4_ALPHA_PASSWORD_SHA256__ = "";
// window.__M3T4_AUTH_MODE__ = "alpha-token";
