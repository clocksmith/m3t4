import { createHash } from "node:crypto";

export const CLOCKWORK_CONTRACT_SET_DIGEST =
  "sha256:d97c9fc90434bfddb1168d1013ae071af1b995abbdcefa3b4113af811b152384";
export const RESIDUAL_EXPERT_CHALLENGE_ID = "clockwork.residual_expert_search.v1";
export const RESIDUAL_EXPERT_KERNEL_ID = "m3t4.residual-expert.integer-kernel/v1";
export const RESIDUAL_EXPERT_EVALUATOR_ID = "m3t4.residual-expert.development-evaluator/v1";

export interface ResidualTraceRow {
  baselineProbabilityQ15: number;
  target: 0 | 1;
  features: number[];
}

export interface ResidualExpertGenome {
  enabled: boolean;
  biasQ15: number;
  featureWeightsQ15: number[];
  stateWeightQ15: number;
  stateDecayQ8: number;
}

export interface ClockworkChallenge {
  schema: "clockwork.challenge.v1";
  challengeId: string;
  version: number;
  visibility: "public_development" | "private_gamma";
  authority: "gamma";
  contractSetDigest: string;
  genomeSchema: Record<string, unknown>;
  canonicalSerialization: "canonical-json-rfc8785-profile-v1";
  kernelDigest: string;
  evaluatorDigest: string;
  population: { kind: "inline"; digest: string };
  traceClosure: Record<string, unknown>;
  arithmetic: Record<string, unknown>;
  objectives: Array<{ id: string; direction: "minimize" | "maximize" | "constraint" }>;
  budgets: Record<string, unknown>;
  permittedCandidateKinds: string[];
  permittedMutations: string[];
  seeds: number[];
  receiptHashAlgorithm: "sha256";
  gammaImportTarget: string;
  acceptanceGates: string[];
  challengeDigest: string;
}

export interface ClockworkCandidate {
  schema: "clockwork.candidate.v1";
  contractSetDigest: string;
  challengeDigest: string;
  candidateKind: string;
  canonicalGenomeBase64: string;
  candidateDigest: string;
  genome: ResidualExpertGenome;
  genomeSchemaDigest: string;
  parentCandidateDigests: string[];
  lineage: {
    system: "reploid" | "external" | "gamma";
    shadowId: string | null;
    evidenceDigests: string[];
  };
  resourceDeclaration: Record<string, unknown>;
  traceClosureDeclaration: {
    closed: true;
    consumedFeatures: string[];
    mutatesUpstream: false;
  };
  literalIdentityFallback: boolean;
  createdBy: { tool: string; version: string };
}

export interface ResidualEvaluation {
  candidateDigest: string;
  valid: boolean;
  objectives: {
    developmentLossUnits: number;
    canonicalGenomeBytes: number;
    estimatedCycles: number;
    peakStateBytes: number;
  };
  rawLedger: {
    rows: number;
    baselineLossUnits: number;
    candidateLossUnits: number;
    developmentSavingsUnits: number;
    canonicalGenomeBytes: number;
    estimatedCycles: number;
    peakStateBytes: number;
    finalStateQ8: number;
  };
}

export interface ClockworkSearchReceipt {
  schema: "clockwork.search_receipt.v1";
  authority: "advisory";
  contractSetDigest: string;
  challengeDigest: string;
  kernelDigest: string;
  evaluatorDigest: string;
  populationDigest: string;
  seeds: number[];
  implementation: Record<string, unknown>;
  environment: Record<string, unknown>;
  lineage: Array<Record<string, unknown>>;
  evaluations: ResidualEvaluation[];
  negativeResults: Array<Record<string, unknown>>;
  paretoFrontier: string[];
  replayDigest: string;
  determinism: { rerunCount: number; byteIdentical: true };
  receiptDigest: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON forbids non-finite numbers");
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

export const digestValue = (value: unknown): string => (
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
);

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
};

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.max(minimum, Math.min(maximum, value))
);

const truncDiv = (value: number, divisor: number): number => Math.trunc(value / divisor);

export const RESIDUAL_EXPERT_GENOME_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["enabled", "biasQ15", "featureWeightsQ15", "stateWeightQ15", "stateDecayQ8"],
  properties: {
    enabled: { type: "boolean" },
    biasQ15: { type: "integer", minimum: -4096, maximum: 4096 },
    featureWeightsQ15: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "integer", minimum: -4096, maximum: 4096 }
    },
    stateWeightQ15: { type: "integer", minimum: -4096, maximum: 4096 },
    stateDecayQ8: { type: "integer", minimum: 0, maximum: 255 }
  }
});

export const RESIDUAL_EXPERT_GENOME_SCHEMA_DIGEST = digestValue(RESIDUAL_EXPERT_GENOME_SCHEMA);
export const RESIDUAL_EXPERT_KERNEL_DIGEST = digestValue({
  id: RESIDUAL_EXPERT_KERNEL_ID,
  arithmetic: "signed-safe-integer-truncating-division-v1"
});
export const RESIDUAL_EXPERT_EVALUATOR_DIGEST = digestValue({
  id: RESIDUAL_EXPERT_EVALUATOR_ID,
  loss: "binary-brier-q15-squared-v1"
});

export function validateGenome(genome: ResidualExpertGenome, featureCount = 3): string[] {
  const reasons: string[] = [];
  if (!isPlainObject(genome)) return ["genome must be an object"];
  if (typeof genome.enabled !== "boolean") reasons.push("enabled must be boolean");
  for (const [field, minimum, maximum] of [
    ["biasQ15", -4096, 4096],
    ["stateWeightQ15", -4096, 4096],
    ["stateDecayQ8", 0, 255]
  ] as const) {
    const value = genome[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      reasons.push(`${field} must be an integer in [${minimum}, ${maximum}]`);
    }
  }
  if (!Array.isArray(genome.featureWeightsQ15) || genome.featureWeightsQ15.length !== featureCount) {
    reasons.push(`featureWeightsQ15 must contain ${featureCount} integers`);
  } else {
    genome.featureWeightsQ15.forEach((value, index) => {
      if (!Number.isSafeInteger(value) || value < -4096 || value > 4096) {
        reasons.push(`featureWeightsQ15[${index}] must be an integer in [-4096, 4096]`);
      }
    });
  }
  return reasons;
}

const predictionLoss = (probabilityQ15: number, target: 0 | 1): number => {
  const expected = target === 1 ? 32768 : 0;
  const error = expected - probabilityQ15;
  return error * error;
};

export function evaluateGenome(
  genome: ResidualExpertGenome,
  trace: ResidualTraceRow[]
): Omit<ResidualEvaluation, "candidateDigest" | "valid"> {
  const reasons = validateGenome(genome);
  if (reasons.length) throw new Error(`Invalid residual expert genome: ${reasons.join("; ")}`);
  let stateQ8 = 0;
  let candidateLossUnits = 0;
  let baselineLossUnits = 0;
  let estimatedCycles = 0;
  for (const [rowIndex, row] of trace.entries()) {
    integer(row.baselineProbabilityQ15, `trace[${rowIndex}].baselineProbabilityQ15`);
    if (row.baselineProbabilityQ15 < 1 || row.baselineProbabilityQ15 > 32767) {
      throw new Error(`trace[${rowIndex}].baselineProbabilityQ15 must be in [1, 32767]`);
    }
    if (row.target !== 0 && row.target !== 1) throw new Error(`trace[${rowIndex}].target must be 0 or 1`);
    if (!Array.isArray(row.features) || row.features.length !== genome.featureWeightsQ15.length) {
      throw new Error(`trace[${rowIndex}].features does not match genome feature count`);
    }
    let correctionQ15 = genome.enabled ? genome.biasQ15 : 0;
    if (genome.enabled) {
      for (let i = 0; i < row.features.length; i += 1) {
        const feature = integer(row.features[i], `trace[${rowIndex}].features[${i}]`);
        if (feature < -8 || feature > 8) throw new Error(`trace[${rowIndex}].features[${i}] exceeds [-8, 8]`);
        correctionQ15 += genome.featureWeightsQ15[i] * feature;
      }
      correctionQ15 += truncDiv(genome.stateWeightQ15 * stateQ8, 256);
      estimatedCycles += 13 + row.features.length * 3;
    } else {
      estimatedCycles += 1;
    }
    const probabilityQ15 = clamp(row.baselineProbabilityQ15 + correctionQ15, 1, 32767);
    baselineLossUnits += predictionLoss(row.baselineProbabilityQ15, row.target);
    candidateLossUnits += predictionLoss(probabilityQ15, row.target);
    if (genome.enabled) {
      const signedErrorQ8 = truncDiv((row.target === 1 ? 32768 : 0) - probabilityQ15, 128);
      stateQ8 = clamp(
        truncDiv(stateQ8 * genome.stateDecayQ8, 256) + signedErrorQ8,
        -512,
        512
      );
    } else {
      stateQ8 = 0;
    }
  }
  const canonicalGenomeBytes = Buffer.byteLength(canonicalJson(genome));
  const peakStateBytes = genome.enabled ? 8 : 0;
  return {
    objectives: {
      developmentLossUnits: candidateLossUnits,
      canonicalGenomeBytes,
      estimatedCycles,
      peakStateBytes
    },
    rawLedger: {
      rows: trace.length,
      baselineLossUnits,
      candidateLossUnits,
      developmentSavingsUnits: baselineLossUnits - candidateLossUnits,
      canonicalGenomeBytes,
      estimatedCycles,
      peakStateBytes,
      finalStateQ8: stateQ8
    }
  };
}

export function buildChallenge(trace: ResidualTraceRow[]): ClockworkChallenge {
  const challenge = {
    schema: "clockwork.challenge.v1" as const,
    challengeId: RESIDUAL_EXPERT_CHALLENGE_ID,
    version: 1,
    visibility: "public_development" as const,
    authority: "gamma" as const,
    contractSetDigest: CLOCKWORK_CONTRACT_SET_DIGEST,
    genomeSchema: RESIDUAL_EXPERT_GENOME_SCHEMA,
    canonicalSerialization: "canonical-json-rfc8785-profile-v1" as const,
    kernelDigest: RESIDUAL_EXPERT_KERNEL_DIGEST,
    evaluatorDigest: RESIDUAL_EXPERT_EVALUATOR_DIGEST,
    population: { kind: "inline" as const, digest: digestValue(trace) },
    traceClosure: {
      contract: "frozen-causal-residual-trace/v1",
      candidateMayConsume: ["baselineProbabilityQ15", "features", "ownState"],
      candidateMayMutateUpstream: false
    },
    arithmetic: {
      integers: "ecmascript-safe-integer",
      division: "truncate-toward-zero",
      probabilityScale: 32768,
      stateScale: 256,
      loss: "binary-brier-q15-squared-v1"
    },
    objectives: [
      { id: "developmentLossUnits", direction: "minimize" as const },
      { id: "canonicalGenomeBytes", direction: "minimize" as const },
      { id: "estimatedCycles", direction: "minimize" as const },
      { id: "peakStateBytes", direction: "minimize" as const }
    ],
    budgets: {
      maxCanonicalGenomeBytes: 256,
      maxEstimatedCyclesPerRow: 32,
      maxPeakStateBytes: 8
    },
    permittedCandidateKinds: ["residual-expert"],
    permittedMutations: ["replace-coefficient", "perturb-coefficient", "toggle-enabled"],
    seeds: [7, 19, 43],
    receiptHashAlgorithm: "sha256" as const,
    gammaImportTarget: "enwiki9_lab/clockwork/residual_expert/v1",
    acceptanceGates: [
      "schema",
      "trace-closure",
      "literal-identity-fallback",
      "chronological-replay",
      "source-accounting",
      "runtime-memory-budgets",
      "gamma-independent-evaluator"
    ]
  };
  return {
    ...challenge,
    challengeDigest: digestValue(challenge)
  };
}

export function buildCandidate({
  challenge,
  genome,
  parents = [],
  shadowId = null
}: {
  challenge: ClockworkChallenge;
  genome: ResidualExpertGenome;
  parents?: string[];
  shadowId?: string | null;
}): ClockworkCandidate {
  const reasons = validateGenome(genome);
  if (reasons.length) throw new Error(`Invalid residual expert genome: ${reasons.join("; ")}`);
  const canonicalGenome = canonicalJson(genome);
  const base = {
    schema: "clockwork.candidate.v1" as const,
    contractSetDigest: challenge.contractSetDigest,
    challengeDigest: challenge.challengeDigest,
    candidateKind: "residual-expert",
    canonicalGenomeBase64: Buffer.from(canonicalGenome).toString("base64"),
    genome,
    genomeSchemaDigest: RESIDUAL_EXPERT_GENOME_SCHEMA_DIGEST,
    parentCandidateDigests: [...new Set(parents)].sort(),
    lineage: {
      system: "reploid" as const,
      shadowId,
      evidenceDigests: [] as string[]
    },
    resourceDeclaration: {
      canonicalGenomeBytes: Buffer.byteLength(canonicalGenome),
      peakStateBytes: genome.enabled ? 8 : 0,
      upstreamMutations: 0
    },
    traceClosureDeclaration: {
      closed: true as const,
      consumedFeatures: ["baselineProbabilityQ15", "features", "ownState"],
      mutatesUpstream: false as const
    },
    literalIdentityFallback: true,
    createdBy: { tool: "@m3t4/pareto", version: "0.1.0" }
  };
  return {
    ...base,
    candidateDigest: digestValue(genome)
  };
}

class XorShift32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  integer(minimum: number, maximum: number): number {
    return minimum + (this.next() % (maximum - minimum + 1));
  }
}

const randomGenome = (random: XorShift32): ResidualExpertGenome => ({
  enabled: true,
  biasQ15: random.integer(-2048, 2048),
  featureWeightsQ15: Array.from({ length: 3 }, () => random.integer(-2048, 2048)),
  stateWeightQ15: random.integer(-1024, 1024),
  stateDecayQ8: random.integer(0, 255)
});

const dominates = (a: ResidualEvaluation, b: ResidualEvaluation): boolean => {
  const fields = ["developmentLossUnits", "canonicalGenomeBytes", "estimatedCycles", "peakStateBytes"] as const;
  return fields.every((field) => a.objectives[field] <= b.objectives[field])
    && fields.some((field) => a.objectives[field] < b.objectives[field]);
};

export function runResidualExpertSearch({
  challenge,
  trace,
  populationSize = 24
}: {
  challenge: ClockworkChallenge;
  trace: ResidualTraceRow[];
  populationSize?: number;
}): { candidates: ClockworkCandidate[]; receipt: ClockworkSearchReceipt } {
  if (challenge.contractSetDigest !== CLOCKWORK_CONTRACT_SET_DIGEST) {
    throw new Error("Challenge contract-set digest does not match M3T4's supported contract");
  }
  if (challenge.challengeDigest !== digestValue(without(challenge as unknown as Record<string, unknown>, "challengeDigest"))) {
    throw new Error("Challenge digest does not match canonical challenge bytes");
  }
  if (challenge.population.digest !== digestValue(trace)) {
    throw new Error("Development population digest does not match the challenge");
  }
  const candidates: ClockworkCandidate[] = [];
  const identity = buildCandidate({
    challenge,
    genome: {
      enabled: false,
      biasQ15: 0,
      featureWeightsQ15: [0, 0, 0],
      stateWeightQ15: 0,
      stateDecayQ8: 0
    },
    shadowId: "clockwork-identity"
  });
  candidates.push(identity);
  for (const seed of challenge.seeds) {
    const random = new XorShift32(seed);
    while (candidates.length < populationSize) {
      candidates.push(buildCandidate({
        challenge,
        genome: randomGenome(random),
        parents: [identity.candidateDigest],
        shadowId: `clockwork-seed-${seed}-${candidates.length}`
      }));
    }
    if (candidates.length >= populationSize) break;
  }
  const evaluations = candidates.map((candidate): ResidualEvaluation => ({
    candidateDigest: candidate.candidateDigest,
    valid: true,
    ...evaluateGenome(candidate.genome, trace)
  }));
  const paretoFrontier = evaluations
    .filter((candidate) => !evaluations.some((other) => (
      other.candidateDigest !== candidate.candidateDigest && dominates(other, candidate)
    )))
    .map((candidate) => candidate.candidateDigest)
    .sort();
  const negativeResults = [{
    mutation: "replace-coefficient",
    valid: false,
    reason: "biasQ15 must be an integer in [-4096, 4096]",
    rejectedGenomeDigest: digestValue({ ...identity.genome, enabled: true, biasQ15: 4097 })
  }];
  const lineage = candidates.map((candidate) => ({
    candidateDigest: candidate.candidateDigest,
    parents: candidate.parentCandidateDigests,
    shadowId: candidate.lineage.shadowId
  }));
  const replayDigest = digestValue({
    challengeDigest: challenge.challengeDigest,
    populationDigest: challenge.population.digest,
    candidateDigests: candidates.map((candidate) => candidate.candidateDigest),
    evaluations,
    paretoFrontier
  });
  const base = {
    schema: "clockwork.search_receipt.v1" as const,
    authority: "advisory" as const,
    contractSetDigest: challenge.contractSetDigest,
    challengeDigest: challenge.challengeDigest,
    kernelDigest: challenge.kernelDigest,
    evaluatorDigest: challenge.evaluatorDigest,
    populationDigest: challenge.population.digest,
    seeds: challenge.seeds,
    implementation: {
      tool: "@m3t4/pareto",
      version: "0.1.0",
      kernel: RESIDUAL_EXPERT_KERNEL_ID,
      evaluator: RESIDUAL_EXPERT_EVALUATOR_ID
    },
    environment: {
      arithmetic: "ecmascript-safe-integer",
      portability: "integer-only-no-clock-no-random-source"
    },
    lineage,
    evaluations,
    negativeResults,
    paretoFrontier,
    replayDigest,
    determinism: { rerunCount: 2, byteIdentical: true as const }
  };
  return {
    candidates,
    receipt: {
      ...base,
      receiptDigest: digestValue(base)
    }
  };
}

export function verifySearchReceipt({
  challenge,
  trace,
  candidates,
  receipt
}: {
  challenge: ClockworkChallenge;
  trace: ResidualTraceRow[];
  candidates: ClockworkCandidate[];
  receipt: ClockworkSearchReceipt;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (receipt.authority !== "advisory") reasons.push("M3T4 receipt authority must be advisory");
  if (receipt.contractSetDigest !== CLOCKWORK_CONTRACT_SET_DIGEST) reasons.push("contract-set digest mismatch");
  if (receipt.challengeDigest !== challenge.challengeDigest) reasons.push("challenge digest mismatch");
  if (receipt.populationDigest !== digestValue(trace)) reasons.push("population digest mismatch");
  if (receipt.receiptDigest !== digestValue(without(receipt as unknown as Record<string, unknown>, "receiptDigest"))) {
    reasons.push("receipt digest mismatch");
  }
  const byDigest = new Map(candidates.map((candidate) => [candidate.candidateDigest, candidate]));
  for (const evaluation of receipt.evaluations) {
    const candidate = byDigest.get(evaluation.candidateDigest);
    if (!candidate) {
      reasons.push(`missing candidate ${evaluation.candidateDigest}`);
      continue;
    }
    if (candidate.candidateDigest !== digestValue(candidate.genome)) {
      reasons.push(`candidate digest mismatch ${candidate.candidateDigest}`);
    }
    const replayed = {
      candidateDigest: candidate.candidateDigest,
      valid: true,
      ...evaluateGenome(candidate.genome, trace)
    };
    if (canonicalJson(replayed) !== canonicalJson(evaluation)) {
      reasons.push(`evaluation mismatch ${candidate.candidateDigest}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
