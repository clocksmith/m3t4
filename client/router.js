import { defineMode } from "./modes/define-mode.js";
import { pathToRoute, routeToPath } from "./navigate.js";

export function createPathRouter({
  appEl,
  navLinks,
  statusEl,
  modes,
  modeLoaders = {},
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
  const modePromises = {};
  let current = null;
  let currentRoute = null;
  let currentPath = null;
  let renderVersion = 0;

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

  async function loadMode(route) {
    if (routeModes[route]) return routeModes[route];
    const loader = modeLoaders[route];
    if (!loader || !routeEnabled(route)) return null;
    if (!modePromises[route]) {
      modePromises[route] = Promise.resolve()
        .then(loader)
        .then((mode) => {
          routeModes[route] = defineMode(mode);
          return routeModes[route];
        })
        .catch((error) => {
          delete modePromises[route];
          throw error;
        });
    }
    return modePromises[route];
  }

  function activeRouteFor(name) {
    const known = name in routeModes || name in modeLoaders;
    return known && routeEnabled(name) ? name : defaultMode;
  }

  async function render() {
    const version = ++renderVersion;
    const { rawRoute, name, path } = parseLocation();
    const hasLegacyPath = Object.hasOwn(legacyPaths, rawRoute);
    const canonicalPath = hasLegacyPath && legacyPaths[rawRoute] !== rawRoute
      ? routeToPath(legacyPaths[rawRoute])
      : path;
    if (canonicalPath !== path) {
      window.history.replaceState(null, "", canonicalPath + window.location.search);
    }

    let activeName = activeRouteFor(name);
    let mode = routeModes[activeName];
    if (!mode) {
      try {
        mode = await loadMode(activeName);
      } catch (error) {
        if (version !== renderVersion) return;
        console.error(`failed to load route: ${activeName}`, error);
        setStatus(`${activeName} unavailable`);
        activeName = defaultMode;
        mode = routeModes[defaultMode];
      }
    }
    if (version !== renderVersion || !mode) return;
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
    const { name, path } = parseLocation();
    if (!routeEnabled(name)) {
      window.history.replaceState(null, "", routeToPath(defaultMode));
      await render();
      return;
    }
    const activeName = activeRouteFor(name);
    if (current && currentRoute === activeName && currentPath === path) return;
    await render();
  }

  return {
    render,
    refreshRoutes,
    syncNavVisibility,
    routeEnabled,
  };
}
