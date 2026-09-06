export function routeToPath(route) {
  if (!route) return "/";
  if (route.startsWith("/")) return route.replace(/\/+$/, "") || "/";
  return `/${route}`;
}

export function pathToRoute(pathname) {
  const trimmed = String(pathname || "/").replace(/\/+$/, "");
  if (!trimmed || trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function normalizeSearch(search) {
  if (!search) return "";
  return search.startsWith("?") ? search : `?${search}`;
}

function normalizeHash(hash) {
  if (!hash) return "";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

export function routeToUrl(route, { search = "", hash = "" } = {}) {
  return routeToPath(route) + normalizeSearch(search) + normalizeHash(hash);
}

export function navigateTo(route, options = {}) {
  const nextUrl = routeToUrl(route, options);
  const currentUrl = window.location.pathname + window.location.search + window.location.hash;
  if (currentUrl !== nextUrl) {
    window.history.pushState(null, "", nextUrl);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}
