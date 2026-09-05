import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Live exposes the full leaderboard through scrolling and pagination", () => {
  const mode = fs.readFileSync(new URL("../modes/spectate.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../styles/components/arena.css", import.meta.url), "utf8");

  assert.match(mode, /const LEADERBOARD_PAGE_SIZE = 25/);
  assert.match(mode, /getPublicLeaderboardPage/);
  assert.match(mode, /id="leaderboard-more"/);
  assert.match(mode, /id="leaderboard-count"/);
  assert.match(mode, /refreshLeaderboard\(\{ append: true \}\)/);
  assert.match(css, /\.leaderboard-scroll\s*\{[^}]*overflow-y: auto/s);
});
