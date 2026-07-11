import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAMPION_RELEASE_SCHEDULE,
  CHAMPION_RELEASE_TIMEOUT_SECONDS,
  buildChampionRelease,
  championStableDocs,
} from "./championCandidates.js";
import { HANDLE_PATTERN, isReservedSystemHandle } from "./stable-public.js";

test("champion releases use the six-hour production boundary", () => {
  assert.equal(CHAMPION_RELEASE_SCHEDULE, "0 */6 * * *");
  assert.equal(CHAMPION_RELEASE_TIMEOUT_SECONDS, 300);
});

test("a scheduled release creates distinct persistent candidate players", () => {
  const now = Date.parse("2026-07-12T00:00:00.000Z");
  const input = {
    seed: 0x12345678,
    releaseId: now.toString(36),
    candidateCount: 4,
    referenceCount: 2,
    releaseCount: 2,
  };
  const first = buildChampionRelease(input);
  const retry = buildChampionRelease(input);
  assert.deepEqual(retry, first);

  const players = championStableDocs(first, now);
  assert.equal(players.length, 2);
  assert.equal(new Set(players.map((player) => player.userId)).size, 2);
  assert.equal(new Set(players.map((player) => player.handle)).size, 2);

  for (const [index, player] of players.entries()) {
    assert.equal(player.userId, `system:frontier:${first.releaseId}:${index}`);
    assert.match(player.handle, HANDLE_PATTERN);
    assert.equal(isReservedSystemHandle(player.handle), true);
    assert.ok(player.handle.length <= 20);
    assert.equal(player.slots.length, 1);
    assert.equal(player.slots[0].slotIdx, 0);
    assert.equal(player.slots[0].submittedAt, now);
    assert.equal(player.lastActiveAt, now);
  }
});

test("different scheduled releases retain different player identities", () => {
  const releaseA = buildChampionRelease({
    seed: 1,
    releaseId: "releasea",
    candidateCount: 2,
    referenceCount: 1,
    releaseCount: 1,
  });
  const releaseB = buildChampionRelease({
    seed: 2,
    releaseId: "releaseb",
    candidateCount: 2,
    referenceCount: 1,
    releaseCount: 1,
  });
  assert.notEqual(
    championStableDocs(releaseA, 1)[0].userId,
    championStableDocs(releaseB, 2)[0].userId,
  );
});
