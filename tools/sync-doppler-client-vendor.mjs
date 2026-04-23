import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = path.resolve(repoRoot, "..", "doppler", "src");
const targetRoot = path.resolve(repoRoot, "client", "vendor", "doppler", "src");

async function main() {
  const sourceStat = await fs.stat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Doppler source tree not found at ${sourceRoot}`);
  }
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetRoot), { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    force: true,
    verbatimSymlinks: false,
  });
  process.stdout.write(`synced doppler vendor src -> ${targetRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`sync-doppler-client-vendor: ${error.message || error}\n`);
  process.exitCode = 1;
});
