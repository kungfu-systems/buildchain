import { createNativeProofReuseDecision } from "../dev-delivery-warrant.js";
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export async function replayQualifiedNativeWarrant({
  warrant,
  pullRequestNumber,
  expectedHead,
  exactPullRequestHead,
}) {
  if (warrant.phase !== "qualified") return null;
  if (
    !ROOT_PATTERN.test(warrant.nativeProofRoot || "") ||
    !ROOT_PATTERN.test(warrant.nativeProofReuseRoot || "") ||
    !ROOT_PATTERN.test(warrant.qualificationReceiptRoot || "")
  ) {
    throw new Error(
      "qualified Warrant replay is missing rooted native or qualification evidence",
    );
  }
  await exactPullRequestHead(pullRequestNumber, expectedHead);
  return {
    schema: "kungfu.buildchain.two-phase-delivery-result/v1",
    ok: true,
    outcome: "already-qualified-warrant",
    nativeAttempts: 0,
    nativeProofRoot: warrant.nativeProofRoot,
    nativeReuseDecisionRoot: warrant.nativeProofReuseRoot,
    qualificationReceiptRoot: warrant.qualificationReceiptRoot,
    landingAuthority: false,
    qualifiedWarrant: warrant,
  };
}

export async function classifyNativeProofAgainstCurrent(
  proof,
  options,
  client,
) {
  const currentBase = await client.baseSha(options.branch);
  const delta = await client.baseDelta(proof.qualifiedBase, currentBase);
  const current = {
    sourceHead: options.expectedHead,
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    environmentRoot: options.environmentRoot,
    nativeCommandRoot: options.nativeCommandRoot,
    currentBase,
    graphKnown: delta.graphKnown,
    attributionComplete: delta.attributionComplete,
    changedPaths: delta.changedPaths,
    renames: delta.renames,
  };
  return {
    current,
    decision: createNativeProofReuseDecision({ proof, current }),
  };
}
