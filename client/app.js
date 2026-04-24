import { createPathRouter } from "./router.js";
import { navigateTo, pathToRoute, routeToPath } from "./navigate.js";
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

const router = createPathRouter({
  appEl,
  navLinks,
  statusEl,
  modes: MODES,
  optionalModeLoaders: OPTIONAL_MODE_LOADERS,
  legacyPaths: LEGACY_HASH,
  defaultMode: DEFAULT_ROUTE,
  features: FEATURES,
  featureForRoute,
  onPageView: trackPageView,
  preserveSameRoutes: ["spectate"],
});

function migrateLegacyHash() {
  const hash = window.location.hash.replace(/^#/, "").split("?")[0];
  if (!hash) return;
  const canonical = LEGACY_HASH[hash] ?? hash;
  const target = routeToPath(canonical);
  window.history.replaceState(null, "", target + window.location.search);
}

function renderWhoami() {
  const u = auth.user();
  if (u) {
    window.__M3T4_COMPUTE_ACCOUNT_UID__ = u.uid ?? null;
    window.__M3T4_COMPUTE_ACCOUNT_HANDLE__ = u.handle ?? null;
    whoamiEl.innerHTML = `<span>${u.handle ? "@" + u.handle : u.uid}</span>  <a href="#" id="signout">sign out</a>`;
    document.getElementById("signout")?.addEventListener("click", (e) => {
      e.preventDefault();
      auth.signOut();
      renderWhoami();
    });
  } else {
    window.__M3T4_COMPUTE_ACCOUNT_UID__ = null;
    window.__M3T4_COMPUTE_ACCOUNT_HANDLE__ = null;
    whoamiEl.innerHTML = `<a href="/profile">sign in</a>`;
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
    window.__M3T4_COMPUTE_SLACK_WORKER__ = FEATURES.computeSlackWorker === true;
    window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ = FEATURES.computeWebRtcArtifacts === true;
    window.__M3T4_COMPUTE_GENOME_KMER__ = FEATURES.computeGenomeKmer === true;
    if (FEATURES.computeWebRtcArtifacts !== true) {
      window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__ = false;
    }
  } catch {
    // Static/local client without a reachable API keeps optional surfaces hidden.
  }

  await router.refreshRoutes();
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

auth.onChange(renderWhoami);
renderWhoami();
router.syncNavVisibility();
installNavOverflow();
installLinkInterceptor();

window.addEventListener("popstate", router.render);
migrateLegacyHash();
router.render();
loadFeatures();

function installNavOverflow() {
  const moreButton = document.getElementById("nav-more");
  const popover = document.getElementById("nav-more-popover");
  if (!moreButton || !popover) return;
  const nav = moreButton.closest("nav");
  if (!nav) return;

  function visibleOverflowItems() {
    return Array.from(nav.querySelectorAll('a[data-nav="overflow"]'))
      .filter((anchor) => !anchor.hasAttribute("hidden"));
  }

  function populate() {
    const items = visibleOverflowItems();
    popover.innerHTML = items
      .map((anchor) => `
        <a href="${anchor.getAttribute("href") ?? "/"}" role="menuitem" data-route="${anchor.dataset.route ?? ""}" title="${anchor.getAttribute("title") ?? ""}">
          ${anchor.textContent}
        </a>`)
      .join("");
    return items.length;
  }

  function syncButtonVisibility() {
    const count = visibleOverflowItems().length;
    moreButton.hidden = count === 0;
    if (count === 0) close();
    return count;
  }

  function close() {
    popover.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
  }

  function open() {
    if (populate() === 0) return;
    popover.hidden = false;
    moreButton.setAttribute("aria-expanded", "true");
  }

  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (popover.hidden) open();
    else close();
  });
  popover.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) close();
  });
  document.addEventListener("click", (event) => {
    if (popover.hidden) return;
    if (event.target === moreButton || popover.contains(event.target)) return;
    close();
  });
  const observer = new MutationObserver(() => {
    syncButtonVisibility();
  });
  observer.observe(nav, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  syncButtonVisibility();
  window.addEventListener("popstate", close);
  window.addEventListener("popstate", syncButtonVisibility);
  window.addEventListener("resize", () => {
    close();
    syncButtonVisibility();
  });
}
