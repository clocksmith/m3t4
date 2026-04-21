// Hash router. Each mode module exports { mount(el), unmount() }.
// Only one mode active at a time.

import * as spectate from "./modes/spectate.js";
import * as build from "./modes/build.js";
import * as profile from "./modes/profile.js";
import * as intro from "./modes/intro.js";
import * as rules from "./modes/rules.js";
import { status as getStatus } from "./lib/api.js";
import { auth } from "./lib/auth.js";
import { initAnalytics, trackPageView } from "./lib/analytics.js";

initAnalytics();

const FEATURES = {
  p2pDuel: false,
  communityVerify: false,
  proofLab: false,
  zk: false,
  distributedCompute: false,
  computeSlackWorker: false,
  computeReceiptDashboard: false,
  computeLiveBadges: false,
};
window.__M3T4_FEATURES__ = FEATURES;

// Practice was absorbed into build (live test stage + human P1/P2
// toggles). Legacy #practice hash redirects to #build.
const MODES = { intro, build, spectate, profile, rules, about: rules };
const LEGACY_HASH = { practice: "build", lore: "intro", rules: "about" };
const OPTIONAL_MODE_LOADERS = {
  duel: () => import("./modes/duel.js"),
};
const DEFAULT_MODE = "intro";

const appEl = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("#topnav nav a"));
const whoamiEl = document.getElementById("whoami");
const statusEl = document.getElementById("status");

let current = null;

function featureForRoute(route) {
  if (route === "duel") return "p2pDuel";
  return null;
}

function routeEnabled(route) {
  const feature = featureForRoute(route);
  return !feature || FEATURES[feature] === true;
}

function syncNavVisibility() {
  navLinks.forEach((a) => {
    const route = a.dataset.route;
    a.hidden = route ? !routeEnabled(route) : false;
  });
}

function render() {
  const hash = (window.location.hash || "#" + DEFAULT_MODE).slice(1);
  const [rawName] = hash.split("?");
  const name = LEGACY_HASH[rawName] ?? rawName;
  if (LEGACY_HASH[rawName]) { location.hash = "#" + name; return; }
  const activeName = name in MODES && routeEnabled(name) ? name : DEFAULT_MODE;
  const mode = MODES[activeName] ?? MODES[DEFAULT_MODE];

  navLinks.forEach((a) => {
    a.classList.toggle("active", a.dataset.route === activeName);
  });

  if (current && current.unmount) current.unmount();
  appEl.innerHTML = "";
  current = mode;
  mode.mount(appEl, { setStatus: (s) => (statusEl.textContent = s) });
  trackPageView(activeName);
}

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
  } catch {
    // Static/local client without a reachable API keeps optional surfaces hidden.
  }

  syncNavVisibility();

  if (FEATURES.p2pDuel && !MODES.duel) {
    MODES.duel = await OPTIONAL_MODE_LOADERS.duel();
  }

  const [route] = (window.location.hash || "#" + DEFAULT_MODE).slice(1).split("?");
  if (!routeEnabled(route)) {
    window.location.hash = "#" + DEFAULT_MODE;
  } else {
    render();
  }
}

auth.onChange(renderWhoami);
renderWhoami();
syncNavVisibility();

window.addEventListener("hashchange", render);
render();
loadFeatures();
