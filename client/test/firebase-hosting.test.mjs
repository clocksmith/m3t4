import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

test("Hosting revalidates code and gives mutable artwork bounded caching", () => {
  const { hosting } = JSON.parse(fs.readFileSync(path.join(repoRoot, "firebase.json"), "utf8"));
  assert.ok(hosting.ignore.includes("test/**"));
  assert.ok(hosting.ignore.includes("assets/chars/**/packed/**"));
  const code = hosting.headers.find(row => row.source === "**/*.@(js|css|json)");
  assert.equal(code.headers[0].value, "no-cache");
  const art = hosting.headers.find(row => row.source === "/assets/**/*.@(png|webp|svg)");
  assert.equal(art.headers[0].value, "public, max-age=3600, must-revalidate");
  assert.doesNotMatch(art.headers[0].value, /immutable/);
});

test("Firebase Hosting serves the synced sim bundle used by the plasma worker", () => {
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "firebase.json"), "utf8"));
  const hosting = firebaseConfig.hosting ?? {};
  assert.equal(hosting.public, "client");
  assert.ok(!hosting.ignore?.includes("sim/**"), "client/sim must be hosted for worker module imports");

  const workerPath = path.join(repoRoot, "client/workers/plasma-worker.js");
  const workerSource = fs.readFileSync(workerPath, "utf8");
  const simImport = workerSource.match(/from\s+["'](\.\.\/sim\/index\.js)["']/)?.[1];
  assert.equal(simImport, "../sim/index.js");

  const resolvedImport = path.resolve(path.dirname(workerPath), simImport);
  assert.ok(fs.existsSync(resolvedImport), "plasma worker sim import target must exist in client/sim");
});
