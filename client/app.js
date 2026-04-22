import { createHashRouter } from "./router.js";
import {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  MODES,
  OPTIONAL_MODE_LOADERS,
  featureForRoute,
} from "./routes.js";
import { status as getStatus } from "./lib/api.js";
import { auth } from "./lib/auth.js";
import { initAnalytics, trackPageView } from "./lib/analytics.js";

initAnalytics();

const FEATURES = { ...DEFAULT_FEATURES };
window.__M3T4_FEATURES__ = FEATURES;

const appEl = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("#topnav nav a"));
const whoamiEl = document.getElementById("whoami");
const statusEl = document.getElementById("status");

const router = createHashRouter({
  appEl,
  navLinks,
  statusEl,
  modes: MODES,
  optionalModeLoaders: OPTIONAL_MODE_LOADERS,
  legacyHash: LEGACY_HASH,
  defaultMode: DEFAULT_ROUTE,
  features: FEATURES,
  featureForRoute,
  onPageView: trackPageView,
  preserveSameHashRoutes: ["spectate"],
});

function renderWhoami() {
  const u = auth.user();
  if (u) {
    whoamiEl.innerHTML = `<span>${u.handle ? "@" + u.handle : u.uid}</span>  <a href="#" id="signout">sign out</a>`;
    document.getElementById("signout")?.addEventListener("click", (e) => {
      e.preventDefault();
      auth.signOut();
      renderWhoami();
    });
  } else {
    whoamiEl.innerHTML = `<a href="#profile">sign in</a>`;
  }
}

async function loadFeatures() {
  try {
    const s = await getStatus();
    Object.assign(FEATURES, s.features ?? {});
    if (s.computeLabOrigin && !window.__M3T4_COMPUTE_LAB_ORIGIN__) {
      window.__M3T4_COMPUTE_LAB_ORIGIN__ = s.computeLabOrigin;
    }
    if (
      Array.isArray(s.computeStunUrls) &&
      s.computeStunUrls.length > 0 &&
      (!Array.isArray(window.__M3T4_COMPUTE_STUN_URLS__) || window.__M3T4_COMPUTE_STUN_URLS__.length === 0)
    ) {
      window.__M3T4_COMPUTE_STUN_URLS__ = s.computeStunUrls;
    }
    if (FEATURES.computeSlackWorker === true) {
      window.__M3T4_COMPUTE_SLACK_WORKER__ = true;
    }
    if (FEATURES.computeWebRtcArtifacts === true) {
      window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = true;
    }
  } catch {
    // Static/local client without a reachable API keeps optional surfaces hidden.
  }

  await router.refreshRoutes();
}

auth.onChange(renderWhoami);
renderWhoami();
router.syncNavVisibility();

window.addEventListener("hashchange", router.render);
router.render();
loadFeatures();
