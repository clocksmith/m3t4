import test from "node:test";
import assert from "node:assert/strict";

import { portraitCellForHudState } from "../render/canvas2d.js";

test("HUD portrait cells map neutral, hurt, and KO states", () => {
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 1 }, 0), 0);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0.09 }, { tick: 2 }, 0), 1);
  assert.equal(portraitCellForHudState({ dead: true, stun: 0 }, { tick: 3 }, 0), 2);
});

test("HUD portrait keeps short hurt and KO states readable", () => {
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 0 }, 1), 0);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0.09 }, { tick: 10 }, 1), 1);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 20 }, 1), 1);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 80 }, 1), 0);

  assert.equal(portraitCellForHudState({ dead: true, stun: 0 }, { tick: 100 }, 1), 2);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 120 }, 1), 2);
  assert.equal(portraitCellForHudState({ dead: false, stun: 0 }, { tick: 180 }, 1), 0);
});
