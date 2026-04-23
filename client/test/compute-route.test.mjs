import test from "node:test";
import assert from "node:assert/strict";

import { MODES } from "../routes.js";

test("compute route is exposed in the browser mode registry", () => {
  assert.ok(MODES.compute);
});
