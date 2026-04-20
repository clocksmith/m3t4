import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

function runImport(modulePath: string, env: Record<string, string | undefined>) {
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import('${modulePath}').then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(42); })`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return child;
}

test("production hard-fails if AUTH_MODE=dev", () => {
  const child = runImport("./dist/auth.js", {
    NODE_ENV: "production",
    AUTH_MODE: "dev",
  });
  assert.equal(child.status, 42);
  assert.match(child.stderr, /AUTH_MODE=dev is not allowed in production/);
});

test("alpha-token auth requires an alpha token secret", () => {
  const child = runImport("./dist/auth.js", {
    NODE_ENV: "production",
    AUTH_MODE: "alpha-token",
    M3T4_ALPHA_TOKEN: "",
  });
  assert.equal(child.status, 42);
  assert.match(child.stderr, /M3T4_ALPHA_TOKEN is required/);
});

test("production duel/proof token signing requires M3T4_MATCH_TOKEN_SECRET", () => {
  const child = runImport("./dist/verify.js", {
    NODE_ENV: "production",
    M3T4_MATCH_TOKEN_SECRET: "",
  });
  assert.equal(child.status, 42);
  assert.match(child.stderr, /M3T4_MATCH_TOKEN_SECRET is required in production/);
});

test("production CORS narrows to m3t4.ai", () => {
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import('./dist/http-utils.js').then((m) => console.log(m.corsHeaders()['access-control-allow-origin']))",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      CORS_ORIGINS: "https://m3t4.ai",
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), "https://m3t4.ai");
});
