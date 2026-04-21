import { sha256 } from "../plasma/hash.js";
import type { ContentHash } from "../plasma/types.js";

export const PUBLIC_ARTIFACT_VERIFY_KERNEL_ID = "m3t4.public_artifact_verify.v0";
export const PUBLIC_ARTIFACT_VERIFY_KERNEL_HASH = sha256(`${PUBLIC_ARTIFACT_VERIFY_KERNEL_ID}:canonical-json-sha256`);

export interface PublicArtifactVerifyParams {
  artifactJson: string;
}

export interface PublicArtifactVerifyOutput {
  outputBytes: Uint8Array;
  outputHash: ContentHash;
}

export function runPublicArtifactVerify(params: PublicArtifactVerifyParams): PublicArtifactVerifyOutput {
  if (typeof params.artifactJson !== "string" || params.artifactJson.length === 0) {
    throw new Error("artifactJson required");
  }
  const outputBytes = new TextEncoder().encode(params.artifactJson);
  return {
    outputBytes,
    outputHash: sha256(outputBytes),
  };
}
