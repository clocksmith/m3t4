import * as intro from "./modes/intro.js";

export {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  featureForRoute,
} from "./route-config.js";

export const MODES = {
  intro,
};

const loadRules = () => import("./modes/rules.js");

export const MODE_LOADERS = {
  tune: () => import("./modes/build.js"),
  live: () => import("./modes/spectate.js"),
  roster: () => import("./modes/profile.js"),
  compute: () => import("./modes/compute.js"),
  rules: loadRules,
  about: loadRules,
  duel: () => import("./modes/duel.js"),
};

export const ROUTE_NAMES = [...Object.keys(MODES), ...Object.keys(MODE_LOADERS)];
