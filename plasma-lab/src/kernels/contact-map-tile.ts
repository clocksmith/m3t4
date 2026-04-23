import { canonicalJson, sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const CONTACT_MAP_TILE_KERNEL_ID = "science.contact_map_tile.v0";
export const CONTACT_MAP_TILE_KERNEL_BINDING = {
  kernelId: CONTACT_MAP_TILE_KERNEL_ID,
  contract: "protein-contact-score-tile-v1",
  determinismClass: "bit-exact-u32",
  serialization: "little-endian-u32-output-v1",
  outputSchema: "contact-score-u32-tile-v1",
  residueAlphabet: "ACDEFGHIKLMNPQRSTVWYX",
};
export const CONTACT_MAP_TILE_KERNEL_HASH = sha256(canonicalJson(CONTACT_MAP_TILE_KERNEL_BINDING));

const RESIDUE_ALPHABET = CONTACT_MAP_TILE_KERNEL_BINDING.residueAlphabet;
const HYDROPHOBICITY = [1, 2, 0, 0, 3, 0, 1, 4, 0, 4, 3, 0, 0, 0, 0, 0, 1, 3, 3, 2, 0];
const CHARGE = [0, 0, -1, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
const AROMATIC = [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
const POLAR = [0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0];

const CYS_INDEX = 1;
const GLY_INDEX = 5;
const PRO_INDEX = 12;
const UNKNOWN_INDEX = 20;

export interface ContactMapTileParams {
  rowResidues: string;
  colResidues: string;
  rowStart: number;
  colStart: number;
  minSeparation: number;
}

export interface ContactMapTileOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function normalizeContactMapTileParams(params: Partial<ContactMapTileParams>): ContactMapTileParams {
  const rowResidues = normalizeResidues(params.rowResidues, "rowResidues");
  const colResidues = normalizeResidues(params.colResidues, "colResidues");
  const rowStart = asInt(params.rowStart ?? 0, "rowStart");
  const colStart = asInt(params.colStart ?? 0, "colStart");
  const minSeparation = asInt(params.minSeparation ?? 8, "minSeparation");
  if (rowResidues.length * colResidues.length > 4096) {
    throw new Error("contact map tile output is capped at 4096 cells");
  }
  if (minSeparation > 256) throw new Error("minSeparation must be 0..256");
  return { rowResidues, colResidues, rowStart, colStart, minSeparation };
}

export function runContactMapTileReference(params: ContactMapTileParams): ContactMapTileOutput {
  const spec = normalizeContactMapTileParams(params);
  const rowCodes = encodeResidues(spec.rowResidues);
  const colCodes = encodeResidues(spec.colResidues);
  const out = new Uint8Array(rowCodes.length * colCodes.length * 4);
  const view = new DataView(out.buffer);
  for (let row = 0; row < rowCodes.length; row++) {
    for (let col = 0; col < colCodes.length; col++) {
      const score = contactMapScore(
        rowCodes[row],
        colCodes[col],
        spec.rowStart + row,
        spec.colStart + col,
        spec.minSeparation,
      );
      view.setUint32((row * colCodes.length + col) * 4, score, true);
    }
  }
  return { outputBytes: out, outputHash: sha256(out) };
}

function normalizeResidues(value: unknown, label: string): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (text.length < 1 || text.length > 64) throw new Error(`${label} must be 1..64 residues`);
  for (const residue of text) {
    if (!RESIDUE_ALPHABET.includes(residue)) {
      throw new Error(`${label} contains unsupported residue "${residue}"`);
    }
  }
  return text;
}

function encodeResidues(text: string): number[] {
  return Array.from(text, (residue) => {
    const index = RESIDUE_ALPHABET.indexOf(residue);
    if (index < 0) throw new Error(`unsupported residue "${residue}"`);
    return index;
  });
}

function contactMapScore(rowCode: number, colCode: number, rowPos: number, colPos: number, minSeparation: number): number {
  const separation = Math.abs(rowPos - colPos);
  if (separation < minSeparation) return 0;
  const hydroSum = HYDROPHOBICITY[rowCode] + HYDROPHOBICITY[colCode];
  let score = 12;
  if (hydroSum >= 4) score += (hydroSum - 3) * 24;
  if (AROMATIC[rowCode] && AROMATIC[colCode]) score += 40;
  if (POLAR[rowCode] && POLAR[colCode]) score += 10;
  if (CHARGE[rowCode] && CHARGE[colCode]) {
    if (CHARGE[rowCode] + CHARGE[colCode] === 0) score += 34;
    else if (CHARGE[rowCode] === CHARGE[colCode]) score -= 22;
  }
  if (rowCode === CYS_INDEX && colCode === CYS_INDEX) score += 52;
  if (rowCode === GLY_INDEX || rowCode === PRO_INDEX || colCode === GLY_INDEX || colCode === PRO_INDEX) score -= 8;
  if (rowCode === UNKNOWN_INDEX || colCode === UNKNOWN_INDEX) score -= 14;
  score += separationBonus(separation);
  return Math.max(0, score) >>> 0;
}

function separationBonus(separation: number): number {
  if (separation < 12) return 8;
  if (separation < 24) return 18;
  if (separation < 64) return 12;
  return 6;
}

function asInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 31 - 1) {
    throw new Error(`invalid ${label}`);
  }
  return n;
}
