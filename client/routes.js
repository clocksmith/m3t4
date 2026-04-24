import * as spectate from "./modes/spectate.js";
import * as build from "./modes/build.js";
import * as profile from "./modes/profile.js";
import * as intro from "./modes/intro.js";
import * as rules from "./modes/rules.js";
import * as compute from "./modes/compute.js";

export {
  DEFAULT_FEATURES,
  DEFAULT_ROUTE,
  LEGACY_HASH,
  featureForRoute,
} from "./route-config.js";

export const MODES = {
  intro,
  tune: build,
  live: spectate,
  roster: profile,
  compute,
  rules,
  about: rules,
};

export const OPTIONAL_MODE_LOADERS = {
  duel: () => import("./modes/duel.js"),
};
