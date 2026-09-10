import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verifyNativeQualificationProof } from "../dev-delivery-warrant.js";
import { resolveCandidateAffectedPaths } from "../candidate/evidence.js";
import { readJson, writeJson } from "./files.js";
import { runTwoPhaseDelivery } from "./qualification.js";
import { verifyNativeQualificationReadback } from "./readback.js";
import { recordNativeJobContext } from "./context-record.js";
function candidateEvidence(workspace, candidate, sourceProofRoot) {
  return {
    ...candidate,
    affectedPaths: resolveCandidateAffectedPaths({
      affectedPaths: candidate.affectedPaths,
      sourceProofRoot,
      source: {
        repository: candidate.repository,
        protectedBase: candidate.branch,
        sourceHead: candidate.expectedHead,
        sourceIdentityRoot: candidate.sourceIdentityRoot,
      },
      readProof: () =>
        readJson(
          path.join(workspace, ".buildchain/dev-delivery/source-proof.json"),
          "source proof",
        ),
    }),
  };
}
export function verifyAdmittedRuntimeSelection(
  file,
  { runtimeSha, runtimeSelectionRoot },
) {
  const bytes = fs.readFileSync(file);
  const selection = JSON.parse(bytes);
  if (
    selection.resolvedSha !== runtimeSha ||
    `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` !==
      runtimeSelectionRoot
  )
    throw new Error("Rooted runtime selection differs from admission");
  return selection;
}
export function verifyNativeProofFile(file, output) {
  const result = verifyNativeQualificationProof(readJson(file, "native proof"));
  writeJson(output, result);
  if (!result.ok || result.reason !== "exact-native-proof")
    throw new Error(`Native proof verification failed: ${result.reason}`);
  return result;
}
export async function executeDeliveryNative(
  {
    workspace,
    candidate,
    runtimeSha,
    runtimeSelectionRoot,
    sourceProofRoot,
    reusableNativeProof,
    run,
    runner,
  },
  dependencies = {},
) {
  const evidenceDirectory = path.join(workspace, ".buildchain/dev-delivery");
  let outcome = "failed";
  try {
    verifyAdmittedRuntimeSelection(
      path.join(evidenceDirectory, "runtime-selection.json"),
      { runtimeSha, runtimeSelectionRoot },
    );
    let nativeProofPath = "";
    if (reusableNativeProof) {
      nativeProofPath = path.join(
        evidenceDirectory,
        "reusable-native-proof.json",
      );
      writeJson(nativeProofPath, reusableNativeProof);
      verifyNativeProofFile(
        nativeProofPath,
        path.join(evidenceDirectory, "reusable-native-proof-verification.json"),
      );
    }
    const result = await runTwoPhaseDelivery(
      {
        ...candidateEvidence(workspace, candidate, sourceProofRoot),
        warrantResultPath: path.join(evidenceDirectory, "warrant.json"),
        candidateDirectory: path.join(workspace, ".buildchain/candidate"),
        evidenceDirectory,
        nativeProofPath,
        nativeOnly: true,
        finalizeOnly: false,
      },
      dependencies,
    );
    writeJson(
      path.join(evidenceDirectory, "two-phase-native-result.json"),
      result,
    );
    const outputs = verifyNativeQualificationReadback(result, candidate, {
      native: true,
    });
    outcome = "succeeded";
    return outputs;
  } finally {
    recordNativeJobContext({
      output: path.join(evidenceDirectory, "native-job-context.json"),
      outcome,
      run,
      runner,
    });
  }
}
export async function qualifyTransferredNative(
  { workspace, runtimeRoot, candidate, sourceProofRoot, token, apiUrl },
  dependencies = {},
) {
  const evidenceDirectory = path.join(
    workspace,
    ".buildchain/finalizer-evidence",
  );
  const nativeProofPath = path.join(
    workspace,
    ".buildchain/native-transfer/native-proof.json",
  );
  // Proof validation precedes any Warrant provider mutation.
  verifyNativeProofFile(
    nativeProofPath,
    path.join(workspace, ".buildchain/provider-native-proof-verification.json"),
  );
  const result = await runTwoPhaseDelivery(
    {
      ...candidateEvidence(workspace, candidate, sourceProofRoot),
      token,
      apiUrl,
      warrantResultPath: path.join(
        workspace,
        ".buildchain/dev-delivery/warrant.json",
      ),
      candidateDirectory: runtimeRoot,
      evidenceDirectory,
      nativeProofPath,
      nativeOnly: false,
      finalizeOnly: true,
    },
    dependencies,
  );
  writeJson(path.join(evidenceDirectory, "two-phase-result.json"), result);
  const outputs = verifyNativeQualificationReadback(result, candidate, {
    native: false,
  });
  fs.copyFileSync(
    path.join(evidenceDirectory, "qualified-warrant.json"),
    path.join(workspace, ".buildchain/dev-delivery/warrant.json"),
  );
  return outputs;
}
