import { defineMode } from "./modes/define-mode.js";
import { pathToRoute, routeToPath } from "./navigate.js";

export function createPathRouter({
  appEl,
  navLinks,
  statusEl,
  modes,
  optionalModeLoaders = {},
  legacyPaths = {},
  defaultMode = "intro",
  features = {},
  featureForRoute = () => null,
  onPageView = () => {},
  preserveSameRoutes = [],
}) {
  const routeModes = {};
  for (const [route, mode] of Object.entries(modes)) {
    routeModes[route] = defineMode(mode);
  }

  const preserveSame = new Set(preserveSameRoutes);
  let current = null;
  let currentRoute = null;
  let currentPath = null;

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

  function parseLocation() {
    const rawRoute = pathToRoute(window.location.pathname);
    const mapped = legacyPaths[rawRoute] ?? rawRoute;
    const name = mapped || defaultMode;
    return { rawRoute, name, path: window.location.pathname };
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
    const { rawRoute, name, path } = parseLocation();
    const hasLegacyPath = Object.hasOwn(legacyPaths, rawRoute);
    const canonicalPath = hasLegacyPath && legacyPaths[rawRoute] !== rawRoute
      ? routeToPath(legacyPaths[rawRoute])
      : path;
    if (canonicalPath !== path) {
      window.history.replaceState(null, "", canonicalPath + window.location.search);
    }

    const activeName = activeRouteFor(name);
    const mode = routeModes[activeName] ?? routeModes[defaultMode];
    syncNavActive(activeName);

    if (
      current &&
      preserveSame.has(activeName) &&
      currentRoute === activeName &&
      currentPath === canonicalPath
    ) {
      return;
    }

    if (current) current.unmount();
    appEl.innerHTML = "";
    current = mode;
    currentRoute = activeName;
    currentPath = canonicalPath;
    mode.mount(appEl, { setStatus, route: activeName, features });
    onPageView(activeName);
  }

  async function refreshRoutes() {
    syncNavVisibility();
    await loadOptionalModes();
    const { name } = parseLocation();
    if (!routeEnabled(name)) {
      window.history.replaceState(null, "", routeToPath(defaultMode));
      render();
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
