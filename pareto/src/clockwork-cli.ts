import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildChallenge,
  canonicalJson,
  runResidualExpertSearch,
  type ResidualTraceRow
} from "./clockwork.js";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "clockwork"
);

const format = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function main(): Promise<void> {
  const tracePath = path.join(directory, "residual-expert-development.json");
  const trace = JSON.parse(await readFile(tracePath, "utf8")) as ResidualTraceRow[];
  const challenge = buildChallenge(trace);
  const first = runResidualExpertSearch({ challenge, trace });
  const second = runResidualExpertSearch({ challenge, trace });
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new Error("Clockwork search rerun was not byte-identical");
  }
  const candidatesDirectory = path.join(directory, "candidates");
  await rm(candidatesDirectory, { recursive: true, force: true });
  await mkdir(candidatesDirectory, { recursive: true });
  await writeFile(path.join(directory, "challenge.json"), format(challenge));
  await writeFile(path.join(directory, "search-receipt.json"), format(first.receipt));
  await Promise.all(first.candidates.map((candidate) => (
    writeFile(
      path.join(candidatesDirectory, `${candidate.candidateDigest.slice("sha256:".length)}.json`),
      format(candidate)
    )
  )));
  process.stdout.write(
    `${first.candidates.length} candidates; ${first.receipt.paretoFrontier.length} frontier; `
    + `${first.receipt.receiptDigest}\n`
  );
}

await main();
