# Clockwork residual-expert search

This directory is M3T4's first bounded Clockwork search lane. It consumes a
Gamma-authored `clockwork.challenge.v1`, evaluates trace-closed integer genomes,
and emits `clockwork.candidate.v1` artifacts plus an advisory
`clockwork.search_receipt.v1`.

Run and reproduce it:

```bash
npm -w pareto test
npm -w pareto run clockwork
```

The generator reruns the search twice and fails unless the complete in-memory
result is byte-identical. It then replaces `candidates/` and writes:

- `challenge.json`
- `search-receipt.json`
- 24 digest-named candidate artifacts

The frozen development population contains only causal baseline probabilities,
bounded public features, labels, and candidate-owned state. The evaluator uses
integer Brier loss as an advisory development objective. It does **not** claim
compressed-byte savings, theorem validity, transfer, or Gamma acceptance.

`candidateDigest` is the SHA-256 of canonical genome bytes, as required by the
Gamma contract validator. The identity candidate disables every correction and
must exactly reproduce the frozen baseline ledger.

Gamma independently validates schema, canonical bytes, chronological replay,
resource accounting, and its own acceptance criteria before it can emit a
`gamma.candidate_receipt.v1`. M3T4 never promotes a candidate.
