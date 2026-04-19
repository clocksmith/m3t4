// Real zk-SNARK (Groth16) verifier for L3 proofs.
//
// What this file does:
//   - Loads a Groth16 verification key (vkey.json) at startup.
//   - Registers a verifier in proof.ts's registry keyed by the proof
//     system name embedded in the vkey ("snarkjs-groth16-<circuit>").
//   - The verifier uses snarkjs.groth16.verify() — real cryptography,
//     real soundness (modulo circuit correctness).
//
// What this file does NOT do:
//   - Compile circuits. That needs the circom compiler (Rust binary).
//   - Run trusted-setup ceremony. That produces zkey from r1cs + tau.
//   - Express the brain v3 state machine as constraints. That's the
//     multi-week engineering work deferred in ARCHITECTURE.md.
//
// How to wire a real proof in:
//   1. Write a circom circuit in server/zk/circuit.circom.
//   2. Run circom → r1cs; run snarkjs groth16 setup → zkey; run
//      snarkjs zkey export verificationkey → vkey.json.
//   3. Drop vkey.json at server/zk/vkey.json (path override via
//      ZK_VKEY_PATH).
//   4. Server boot picks it up; the route at /api/proof/zk/submit
//      starts accepting real proofs whose proofSystem matches.
//
// The in-repo BUILD.md documents the full offline build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerProofVerifier } from "./proof.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_VKEY_PATH = path.join(__dirname, "..", "zk", "vkey.json");

interface Groth16Vkey {
  protocol: string;
  curve: string;
  nPublic: number;
  // snarkjs vkey has more fields; we only need shape enough to pass.
  [k: string]: unknown;
}

let loadedVkey: Groth16Vkey | null = null;
let snarkjsModule: any = null;

async function loadSnarkjs(): Promise<any> {
  if (snarkjsModule) return snarkjsModule;
  snarkjsModule = await import("snarkjs");
  return snarkjsModule;
}

function loadVkey(): Groth16Vkey | null {
  const p = process.env.ZK_VKEY_PATH || DEFAULT_VKEY_PATH;
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw.protocol !== "groth16") {
      console.warn(`[zk] vkey at ${p} has protocol "${raw.protocol}", expected "groth16"`);
      return null;
    }
    return raw as Groth16Vkey;
  } catch (e) {
    console.warn(`[zk] failed to load vkey at ${p}:`, e);
    return null;
  }
}

export function initZkVerifiers(): void {
  loadedVkey = loadVkey();
  if (!loadedVkey) {
    console.log("[zk] no vkey.json found; L3 Groth16 route will reject until one is provided.");
    return;
  }
  console.log(`[zk] loaded Groth16 vkey (curve=${loadedVkey.curve}, nPublic=${loadedVkey.nPublic})`);

  registerProofVerifier({
    // Cast to the ProofSystem enum. The enum in proof.ts lists a few
    // known systems; for a real deployment add the circuit name to the
    // union. "snarkjs-groth16" exercises the route end-to-end.
    name: "snarkjs-groth16" as any,
    async verify(env) {
      // env.proofBytesB64 is the JSON-encoded { pi_a, pi_b, pi_c } proof,
      // then base64-encoded. env.publicInputs is the public-signals array.
      let proof: any;
      let publicSignals: any;
      try {
        const proofJson = Buffer.from(env.proofBytesB64, "base64").toString("utf8");
        proof = JSON.parse(proofJson);
      } catch (e) {
        return { ok: false, reason: `proof JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      publicSignals = (env as any).publicInputs;
      if (!Array.isArray(publicSignals)) {
        return { ok: false, reason: "publicInputs must be an array of field elements" };
      }
      try {
        const snarkjs = await loadSnarkjs();
        const ok = await snarkjs.groth16.verify(loadedVkey, publicSignals, proof);
        if (!ok) return { ok: false, reason: "groth16.verify returned false" };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: `snarkjs verify threw: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
  console.log("[zk] registered snarkjs-groth16 verifier");
}
