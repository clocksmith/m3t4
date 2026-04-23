import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };

const clientRoot = path.resolve(new URL("..", import.meta.url).pathname);

for (const body of rosterCatalog.bodies) {
  test(`${body} weapon roster resolves every sheet cell`, () => {
    const weapons = rosterCatalog.weapons[body] ?? [];
    const available = weapons.filter((weapon) => weapon.available);
    assert.equal(available.length, 4, `${body} should expose four available weapons`);

    const cells = [];
    for (const weapon of available) {
      assert.ok(weapon.asset, `${body}/${weapon.id} is missing an asset mapping`);
      assert.equal(weapon.asset.frameW, 48, `${body}/${weapon.id} frameW`);
      assert.equal(weapon.asset.frameH, 48, `${body}/${weapon.id} frameH`);
      assert.equal(weapon.asset.cols, 2, `${body}/${weapon.id} cols`);
      assert.match(weapon.asset.url, new RegExp(`^assets/weapons/${body}/sheet\\.png$`), `${body}/${weapon.id} sheet path`);
      assert.ok(Number.isInteger(weapon.asset.cell), `${body}/${weapon.id} cell must be an integer`);
      assert.ok(weapon.asset.cell >= 0 && weapon.asset.cell <= 3, `${body}/${weapon.id} cell out of range`);
      assert.ok(fs.existsSync(path.join(clientRoot, weapon.asset.url)), `${body}/${weapon.id} sheet file is missing`);
      cells.push(weapon.asset.cell);
    }

    assert.deepEqual(cells.sort((a, b) => a - b), [0, 1, 2, 3], `${body} should cover each 2x2 atlas cell exactly once`);
  });
}
