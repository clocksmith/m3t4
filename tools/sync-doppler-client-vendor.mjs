import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const targetRoot = path.resolve(repoRoot, "client", "vendor", "doppler", "src");

async function main() {
  const sourceRoot = await resolveDopplerSourceRoot();
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

async function resolveDopplerSourceRoot() {
  const explicit = process.env.DOPPLER_SOURCE_ROOT
    ? path.resolve(process.env.DOPPLER_SOURCE_ROOT, "src")
    : null;
  const candidates = [
    explicit,
    path.resolve(repoRoot, "..", "doppler", "src"),
    ...listWorktreeSiblingCandidates(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
  }
  return candidates[0] || path.resolve(repoRoot, "..", "doppler", "src");
}

function listWorktreeSiblingCandidates() {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean)
      .map((worktreePath) => path.resolve(worktreePath, "..", "doppler", "src"));
  } catch {
    return [];
  }
}

main().catch((error) => {
  process.stderr.write(`sync-doppler-client-vendor: ${error.message || error}\n`);
  process.exitCode = 1;
});
