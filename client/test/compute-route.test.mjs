import test from "node:test";
import assert from "node:assert/strict";

import { MODE_LOADERS } from "../routes.js";

test("compute route is exposed as an on-demand browser mode", () => {
  assert.equal(typeof MODE_LOADERS.compute, "function");
});
