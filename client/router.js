import { defineMode } from "./modes/define-mode.js";

export function createHashRouter({
  appEl,
  navLinks,
  statusEl,
  modes,
  optionalModeLoaders = {},
  legacyHash = {},
  defaultMode = "intro",
  features = {},
  featureForRoute = () => null,
  onPageView = () => {},
  preserveSameHashRoutes = [],
}) {
  const routeModes = {};
  for (const [route, mode] of Object.entries(modes)) {
    routeModes[route] = defineMode(mode);
  }

  const preserveSameHash = new Set(preserveSameHashRoutes);
  let current = null;
  let currentRoute = null;
  let currentHash = null;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function routeEnabled(route) {
    const feature = featureForRoute(route);
    return !feature || features[feature] === true;
  }

  function syncNavVisibility() {
    navLinks.forEach((a) => {
      const route = a.dataset.route;
      a.hidden = route ? !routeEnabled(route) : false;
    });
  }

  function syncNavActive(route) {
    navLinks.forEach((a) => {
      a.classList.toggle("active", a.dataset.route === route);
    });
  }

  function parseHash() {
    const hash = (window.location.hash || "#" + defaultMode).slice(1);
    const [rawName] = hash.split("?");
    const name = legacyHash[rawName] ?? rawName;
    return { hash, rawName, name };
  }

  async function loadOptionalModes() {
    for (const [route, loader] of Object.entries(optionalModeLoaders)) {
      if (!routeEnabled(route) || routeModes[route]) continue;
      routeModes[route] = defineMode(await loader());
    }
  }

  function activeRouteFor(name) {
    return name in routeModes && routeEnabled(name) ? name : defaultMode;
  }

  function render() {
    const { hash, rawName, name } = parseHash();
    if (legacyHash[rawName]) {
      location.hash = "#" + name;
      return;
    }

    const activeName = activeRouteFor(name);
    const mode = routeModes[activeName] ?? routeModes[defaultMode];
    syncNavActive(activeName);

    if (
      current &&
      preserveSameHash.has(activeName) &&
      currentRoute === activeName &&
      currentHash === hash
    ) {
      return;
    }

    if (current) current.unmount();
    appEl.innerHTML = "";
    current = mode;
    currentRoute = activeName;
    currentHash = hash;
    mode.mount(appEl, { setStatus, route: activeName, features });
    onPageView(activeName);
  }

  async function refreshRoutes() {
    syncNavVisibility();
    await loadOptionalModes();
    const { name } = parseHash();
    if (!routeEnabled(name)) {
      window.location.hash = "#" + defaultMode;
    } else {
      render();
    }
  }

  return {
    render,
    refreshRoutes,
    syncNavVisibility,
    routeEnabled,
  };
}
