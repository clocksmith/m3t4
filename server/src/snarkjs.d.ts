// Minimal ambient types for snarkjs — only the Groth16 verify surface we use.
declare module "snarkjs" {
  export const groth16: {
    verify(vkey: unknown, publicSignals: readonly unknown[], proof: unknown): Promise<boolean>;
    prove(zkey: unknown, witness: unknown): Promise<{ proof: unknown; publicSignals: unknown[] }>;
    fullProve(input: unknown, wasmPath: string, zkeyPath: string): Promise<{ proof: unknown; publicSignals: unknown[] }>;
  };
  export const plonk: {
    verify(vkey: unknown, publicSignals: readonly unknown[], proof: unknown): Promise<boolean>;
  };
}
