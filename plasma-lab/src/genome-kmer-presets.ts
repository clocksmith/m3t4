export interface GenomeKmerPreset {
  id: string;
  label: string;
  source: "synthetic-didactic" | "public-reference";
  notes: string;
  sequence: string;
  defaultK: number;
}

export const GENOME_KMER_PRESETS: readonly GenomeKmerPreset[] = Object.freeze([
  {
    id: "synthetic-balanced-tetramer",
    label: "Synthetic · balanced ACGT tetramer",
    source: "synthetic-didactic",
    notes: "Perfectly balanced ACGT repeats. Useful as a baseline: every 4-mer that maps into the ACGT cycle should appear with equal count.",
    sequence: "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT",
    defaultK: 3,
  },
  {
    id: "synthetic-at-rich",
    label: "Synthetic · AT-rich window",
    source: "synthetic-didactic",
    notes: "Deliberately AT-biased stretch reflecting non-coding intergenic regions in many eukaryotic genomes.",
    sequence: "ATATATTAAATAAATATTTATAATAAATATTAAATTATATTAAATTATATAAATTATATTAAAT",
    defaultK: 3,
  },
  {
    id: "synthetic-gc-rich",
    label: "Synthetic · GC-rich window",
    source: "synthetic-didactic",
    notes: "Deliberately GC-biased stretch reflecting bacterial or CpG-island composition.",
    sequence: "GCGCGCGGCCGGCCGGCGCGGCCGCGCGGCCGGCCGCGCGGCGCGGCCGGCCGCGCGGCGCGGG",
    defaultK: 3,
  },
  {
    id: "synthetic-homopolymer-ladder",
    label: "Synthetic · homopolymer ladder A/C/G/T",
    source: "synthetic-didactic",
    notes: "Concatenation of A16 C16 G16 T16 — exercises k-mer boundary behavior and is trivial to reason about by hand.",
    sequence: "AAAAAAAAAAAAAAAACCCCCCCCCCCCCCCCGGGGGGGGGGGGGGGGTTTTTTTTTTTTTTTT",
    defaultK: 2,
  },
  {
    id: "synthetic-motif-mix",
    label: "Synthetic · mixed canonical motif window",
    source: "synthetic-didactic",
    notes: "Repeated canonical short motifs (TATAAA, CAATCT, GATCGA, GCGCGC). Produces a characteristically uneven k-mer histogram.",
    sequence: "TATAAACAATCTGATCGAGCGCGCTATAAACAATCTGATCGAGCGCGCTATAAACAATCTGATC",
    defaultK: 4,
  },
]);

const GENOME_KMER_PRESET_INDEX = new Map(GENOME_KMER_PRESETS.map((preset) => [preset.id, preset]));

export function resolveGenomeKmerPreset(id: string): GenomeKmerPreset {
  const key = String(id || "").trim();
  const preset = GENOME_KMER_PRESET_INDEX.get(key);
  if (!preset) throw new Error(`unknown genome kmer preset: ${key}`);
  return preset;
}
