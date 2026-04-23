export interface ContactMapPreset {
  id: string;
  label: string;
  proteinName: string;
  organism: string;
  accession: string;
  sourceDb: string;
  sourceUrl: string;
  sequenceLength: number;
  rowStart: number;
  colStart: number;
  rowResidues: string;
  colResidues: string;
  minSeparation: number;
}

export const CONTACT_MAP_PRESETS: readonly ContactMapPreset[] = Object.freeze([
  {
    id: "human-myoglobin-core-helices",
    label: "Human myoglobin core helices",
    proteinName: "Myoglobin",
    organism: "Homo sapiens",
    accession: "P02144",
    sourceDb: "UniProtKB/Swiss-Prot",
    sourceUrl: "https://rest.uniprot.org/uniprotkb/P02144.fasta",
    sequenceLength: 154,
    rowStart: 8,
    colStart: 64,
    rowResidues: "QLVLNVWGKVEADIPG",
    colResidues: "HGATVLTALGGILKKK",
    minSeparation: 8,
  },
  {
    id: "human-hemoglobin-alpha-fold-core",
    label: "Human hemoglobin alpha fold core",
    proteinName: "Hemoglobin subunit alpha",
    organism: "Homo sapiens",
    accession: "P69905",
    sourceDb: "UniProtKB/Swiss-Prot",
    sourceUrl: "https://rest.uniprot.org/uniprotkb/P69905.fasta",
    sequenceLength: 142,
    rowStart: 0,
    colStart: 64,
    rowResidues: "MVLSPADKTNVKAAWG",
    colResidues: "DALTNAVAHVDDMPNA",
    minSeparation: 8,
  },
  {
    id: "human-lysozyme-stable-core",
    label: "Human lysozyme stable core",
    proteinName: "Lysozyme C",
    organism: "Homo sapiens",
    accession: "P61626",
    sourceDb: "UniProtKB/Swiss-Prot",
    sourceUrl: "https://rest.uniprot.org/uniprotkb/P61626.fasta",
    sequenceLength: 148,
    rowStart: 18,
    colStart: 72,
    rowResidues: "KVFERCELARTLKRLG",
    colResidues: "GIFQINSRYWCNDGKT",
    minSeparation: 8,
  },
]);

const CONTACT_MAP_PRESET_INDEX = new Map(CONTACT_MAP_PRESETS.map((preset) => [preset.id, preset]));

export function resolveContactMapPreset(id: string): ContactMapPreset {
  const key = String(id || "").trim();
  const preset = CONTACT_MAP_PRESET_INDEX.get(key);
  if (!preset) throw new Error(`unknown contact map preset: ${key}`);
  return preset;
}
