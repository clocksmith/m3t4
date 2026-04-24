import fs from "node:fs";
import {
  type ReceiptLogEntry,
  type ReceiptLogSegment,
  type ReceiptLogSegmentBundle,
  verifyReceiptLogArchiveBundle,
} from "./store.js";

function main(): void {
  const inputPath = process.argv[2];
  const raw = inputPath ? fs.readFileSync(inputPath, "utf8") : fs.readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const verification = verifyReceiptLogArchiveBundle(bundlesFromInput(parsed));
  console.log(JSON.stringify(verification, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

function bundlesFromInput(input: unknown): ReceiptLogSegmentBundle[] {
  if (Array.isArray(input)) return input.map(bundleFromUnknown);
  if (!input || typeof input !== "object") throw new Error("receipt log verifier input must be an object or bundle array");
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.bundles)) return value.bundles.map(bundleFromUnknown);
  if (value.segment && Array.isArray(value.entries)) return [bundleFromUnknown(value)];
  if (Array.isArray(value.receiptLogSegments) && Array.isArray(value.receiptLogEntries)) {
    const entries = value.receiptLogEntries as ReceiptLogEntry[];
    return (value.receiptLogSegments as ReceiptLogSegment[])
      .slice()
      .sort((a, b) => a.firstSequence - b.firstSequence)
      .map((segment) => ({
        segment,
        entries: entries
          .filter((entry) => entry.segmentId === segment.segmentId)
          .sort((a, b) => a.sequence - b.sequence),
      }));
  }
  throw new Error("expected {segment, entries}, {bundles}, bundle array, or exported store snapshot");
}

function bundleFromUnknown(input: unknown): ReceiptLogSegmentBundle {
  if (!input || typeof input !== "object") throw new Error("receipt log bundle must be an object");
  const value = input as Record<string, unknown>;
  if (!value.segment || !Array.isArray(value.entries)) throw new Error("receipt log bundle requires segment and entries");
  return {
    segment: value.segment as ReceiptLogSegment,
    entries: value.entries as ReceiptLogEntry[],
  };
}

main();
