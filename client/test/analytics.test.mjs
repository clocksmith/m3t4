import test from "node:test";
import assert from "node:assert/strict";

import {
  track,
  trackPageView,
  trackBuildSlotModeChange,
  trackBuildPresetChange,
  trackBuildStageChange,
  trackBuildAction,
  trackProfileSignIn,
  trackProfileHandleClaim,
  trackProfileSubmitConfig,
} from "../lib/analytics.js";

test("analytics tracking helpers execute safely without throwing", () => {
  assert.doesNotThrow(() => {
    trackPageView("/watch");
    trackPageView("");
    track("custom_event", { key: "value", count: 1 });
    trackBuildSlotModeChange(0, "preset");
    trackBuildPresetChange(1, "sama_rush");
    trackBuildStageChange("neon_rooftop");
    trackBuildAction("reset_match");
    trackProfileSignIn("google", true);
    trackProfileHandleClaim(true);
    trackProfileSubmitConfig(true);
  });
});
