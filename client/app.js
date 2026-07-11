import { createPathRouter } from "./router.js";
import { navigateTo, pathToRoute, routeToPath } from "./navigate.js";
import {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  MODE_LOADERS,
  MODES,
  ROUTE_NAMES,
  featureForRoute,
} from "./routes.js";
import { status as getStatus } from "./lib/api.js";
import { auth } from "./lib/auth.js";
import { initAnalytics, trackPageView } from "./lib/analytics.js";
import { escapeHtml } from "./ui/html.js";

initAnalytics();

const FEATURES = { ...DEFAULT_FEATURES };
window.__M3T4_FEATURES__ = FEATURES;

const appEl = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("#topnav nav a"));
const accountEl = document.getElementById("account");
const statusEl = document.getElementById("status");

const router = createPathRouter({
  appEl,
  navLinks,
  statusEl,
  modes: MODES,
  modeLoaders: MODE_LOADERS,
  legacyPaths: LEGACY_HASH,
  defaultMode: DEFAULT_ROUTE,
  features: FEATURES,
  featureForRoute,
  onPageView: trackPageView,
  preserveSameRoutes: ROUTE_NAMES,
});

function migrateLegacyHash() {
  const hash = window.location.hash.replace(/^#/, "").split("?")[0];
  if (!hash) return;
  const isRouteHash =
    Object.hasOwn(LEGACY_HASH, hash) ||
    ROUTE_NAMES.includes(hash);
  if (!isRouteHash) return;
  const canonical = LEGACY_HASH[hash] ?? hash;
  const target = routeToPath(canonical);
  window.history.replaceState(null, "", target + window.location.search);
}

function accountInitial(u) {
  const source = (u?.handle || u?.uid || "?").trim();
  const ch = source.replace(/^[@_-]+/, "").charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

// Tracks listeners attached for the current account-menu render so a
// subsequent renderAccount() (e.g. on auth change) tears them down
// before binding a fresh set. Without this, document-level listeners
// stack up on every re-render.
let accountListeners = null;

// Top-right profile control. Anonymous → small "sign in" pill that
// opens the profile menu. Signed-in → circular avatar showing the handle
// initial. The menu owns account-adjacent routes so the primary nav can
// stay focused on play/watch/help surfaces.
function renderAccount() {
  const u = auth.user();
  if (u) {
    const label = u.handle ? `@${u.handle}` : u.uid;
    window.__M3T4_COMPUTE_ACCOUNT_UID__ = u.uid ?? null;
    window.__M3T4_COMPUTE_ACCOUNT_HANDLE__ = u.handle ?? null;
    accountEl.dataset.state = "user";
    accountEl.innerHTML = `
      <button type="button" class="account-trigger" id="account-trigger" aria-haspopup="true" aria-expanded="false" title="Open account menu">
        <span class="account-initial" aria-hidden="true">${escapeHtml(accountInitial(u))}</span>
        <span class="visually-hidden">Account menu</span>
      </button>
      <div class="account-menu" id="account-menu" role="menu" hidden>
        <div class="account-menu-handle">${escapeHtml(label)}</div>
        <a class="account-menu-item" href="/roster" role="menuitem">Roster</a>
        <a class="account-menu-item" href="/compute" role="menuitem">Compute</a>
        <button type="button" class="account-menu-item" id="account-signout" role="menuitem">Sign out</button>
      </div>`;
    bindAccountMenu();
  } else {
    window.__M3T4_COMPUTE_ACCOUNT_UID__ = null;
    window.__M3T4_COMPUTE_ACCOUNT_HANDLE__ = null;
    accountEl.dataset.state = "anon";
    accountEl.innerHTML = `
      <button type="button" class="account-signin" id="account-trigger" aria-haspopup="true" aria-expanded="false" title="Open profile menu">sign in</button>
      <div class="account-menu" id="account-menu" role="menu" hidden>
        <div class="account-menu-handle">profile</div>
        <a class="account-menu-item" href="/roster" role="menuitem">Roster / sign in</a>
        <a class="account-menu-item" href="/compute" role="menuitem">Compute</a>
      </div>`;
    bindAccountMenu();
  }
}

function bindAccountMenu() {
  if (accountListeners) {
    try { accountListeners.abort(); } catch {}
  }
  accountListeners = new AbortController();
  const { signal } = accountListeners;

  const trigger = document.getElementById("account-trigger");
  const menu = document.getElementById("account-menu");
  const signout = document.getElementById("account-signout");
  if (!trigger || !menu) return;
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }, { signal });
  document.addEventListener("click", (e) => {
    if (!accountEl.contains(e.target)) close();
  }, { signal });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  }, { signal });
  menu.addEventListener("click", (e) => {
    const item = e.target instanceof Element ? e.target.closest(".account-menu-item") : null;
    if (item) close();
  }, { signal });
  signout?.addEventListener("click", () => {
    auth.signOut();
    renderAccount();
  }, { signal });
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
    window.__M3T4_COMPUTE_SLACK_WORKER__ = FEATURES.computeSlackWorker === true;
    window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = FEATURES.computeWebRtcArtifacts === true;
    window.__M3T4_COMPUTE_GENOME_KMER__ = FEATURES.computeGenomeKmer === true;
    if (FEATURES.computeWebRtcArtifacts !== true) {
      window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__ = false;
    }
    maybeResumeComputeOptIn();
  } catch {
    // Static/local client without a reachable API keeps optional surfaces hidden.
  }

  await router.refreshRoutes();
}

function maybeResumeComputeOptIn() {
  const helper = window.m3t4Compute;
  if (FEATURES.computeSlackWorker !== true || !helper?.status || !helper?.start) return;
  const snapshot = helper.status();
  if (snapshot?.optIn === true && snapshot.enabled !== true) {
    void helper.start(snapshot.mode || "quiet");
  }
}

function installLinkInterceptor() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    if (anchor.target && anchor.target !== "" && anchor.target !== "_self") return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("//")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (anchor.dataset.nativeNav === "true") return;
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
    event.preventDefault();
    const route = pathToRoute(url.pathname);
    navigateTo(route || "/", { search: url.search, hash: url.hash });
  });
}

auth.onChange(renderAccount);
renderAccount();
router.syncNavVisibility();
installLinkInterceptor();

window.addEventListener("popstate", () => void router.render());
migrateLegacyHash();
void router.render();
void loadFeatures();
