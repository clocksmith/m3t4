import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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
