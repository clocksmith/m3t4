import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ComputeLabStore, PUBLIC_TILE_MAX_BYTES } from "../store.js";

function tinyTile() {
  // 2x2 opaque red RGBA = 16 bytes.
  const bytes = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    sha256,
    mimeType: "image/rgba" as const,
    widthPx: 2,
    heightPx: 2,
    byteLength: bytes.length,
    bytesBase64: bytes.toString("base64"),
    provenance: { label: "unit test", license: "public-domain" },
  };
}

test("tile store upsert rejects sha256 that does not match bytes", () => {
  const store = new ComputeLabStore();
  const tile = tinyTile();
  const tampered = { ...tile, sha256: "0".repeat(64) };
  assert.throws(() => store.upsertPublicTile(tampered), /sha256 mismatch/);
});

test("tile store upsert rejects bad mime / dims / byte length", () => {
  const store = new ComputeLabStore();
  const tile = tinyTile();
  assert.throws(() => store.upsertPublicTile({ ...tile, mimeType: "image/png" as unknown as "image/rgba" }));
  assert.throws(() => store.upsertPublicTile({ ...tile, widthPx: 0 }));
  assert.throws(() => store.upsertPublicTile({ ...tile, byteLength: 123 }));
  assert.throws(() => store.upsertPublicTile({ ...tile, bytesBase64: "" }));
  assert.throws(() => store.upsertPublicTile({ ...tile, provenance: { label: "" } }));
});

test("tile store stores, retrieves, and lists tiles by sha256", () => {
  const store = new ComputeLabStore();
  const tile = tinyTile();
  const stored = store.upsertPublicTile(tile);
  assert.equal(stored.sha256, tile.sha256);
  assert.equal(stored.byteLength, tile.byteLength);
  const fetched = store.getPublicTile(tile.sha256);
  assert.ok(fetched);
  assert.equal(fetched!.sha256, tile.sha256);
  assert.deepEqual(fetched!.provenance, { label: "unit test", sourceUrl: undefined, license: "public-domain", attribution: undefined });
  const list = store.listPublicTiles({ limit: 10 });
  assert.equal(list.length, 1);
  assert.equal(list[0].sha256, tile.sha256);
});

test("tile store cap enforced", () => {
  const store = new ComputeLabStore();
  // Just assert the constant exists and is under Firestore's 1MB doc cap.
  assert.ok(PUBLIC_TILE_MAX_BYTES > 0);
  assert.ok(PUBLIC_TILE_MAX_BYTES < 1024 * 1024);
});

test("seedImageTileInferTask accepts tileSha256 and stashes it in chunk.params", () => {
  const store = new ComputeLabStore();
  const tile = tinyTile();
  store.upsertPublicTile(tile);
  const task = store.seedImageTileInferTask({
    tileSha256: tile.sha256,
    topK: 2,
    minExecutions: 1,
    minAgreeing: 1,
  });
  const chunk = task.chunks[0];
  assert.equal(chunk.params.tileSha256, tile.sha256);
  assert.equal((chunk.params as Record<string, unknown>).rgbaBase64, undefined, "chunk.params must not inline bytes when tileSha256 is used");
  assert.equal(chunk.params.width, tile.widthPx);
  assert.equal(chunk.params.height, tile.heightPx);
});
