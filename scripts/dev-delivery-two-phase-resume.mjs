import { createNativeProofReuseDecision, createNativeQualificationProof } from "../packages/core/dev-delivery-warrant.js";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function attributedGitHubBaseDelta(data, previousBase) {
  const files = Array.isArray(data?.files) ? data.files : [];
  const graphKnown =
    data?.status === "ahead" &&
    data?.merge_base_commit?.sha === previousBase &&
    files.length < 300;
  const renames = files
    .filter((entry) => entry.status === "renamed")
    .map((entry) => ({
      from: String(entry.previous_filename || ""),
      to: String(entry.filename || ""),
    }));
  const attributionComplete =
    graphKnown && renames.every((entry) => entry.from && entry.to);
  return {
    graphKnown,
    attributionComplete,
    changedPaths: attributionComplete
      ? [
          ...new Set(
            files
              .flatMap((entry) => [
                String(entry.filename || ""),
                String(entry.previous_filename || ""),
              ])
              .filter(Boolean),
          ),
        ].sort()
      : [],
    renames: attributionComplete ? renames : [],
  };
}

export async function replayQualifiedNativeWarrant({
  warrant,
  pullRequestNumber,
  expectedHead,
  exactPullRequestHead,
}) {
  if (warrant.phase !== "qualified") return null;
  if (
    !ROOT_PATTERN.test(warrant.nativeProofRoot || "") ||
    !ROOT_PATTERN.test(warrant.nativeProofReuseRoot || "")
  ) {
    throw new Error("qualified Warrant is missing rooted native evidence");
  }
  await exactPullRequestHead(pullRequestNumber, expectedHead);
  return {
    schema: "kungfu.buildchain.two-phase-delivery-result/v1",
    ok: true,
    outcome: "already-qualified-warrant",
    nativeAttempts: 0,
    nativeProofRoot: warrant.nativeProofRoot,
    nativeReuseDecisionRoot: warrant.nativeProofReuseRoot,
    qualificationReceiptRoot: null,
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

export async function runNativeQualificationAttempt({
  options,
  warrant,
  attempt,
  client,
  runCommand,
  runNative,
  composeCandidate,
  writeEvidence,
}) {
  await client.exactPullRequestHead(
    options.pullRequestNumber,
    options.expectedHead,
  );
  const qualifiedBase = await client.baseSha(options.branch);
  composeCandidate(
    options.candidateDirectory,
    options.expectedHead,
    qualifiedBase,
  );
  const nativeExecutionReceipt = await runNative({
    command: options.nativeCommand,
    cwd: options.candidateDirectory,
    intervalMs: options.heartbeatSeconds * 1000,
    executionBinding: {
      repository: options.repository,
      protectedBase: options.branch,
      sourceHead: options.expectedHead,
      qualifiedBase,
      toolchainRoot: options.toolchainRoot,
      environmentRoot: options.environmentRoot,
    },
    heartbeat: async () => {
      await runCommand({
        command: "heartbeat",
        repository: options.repository,
        branch: options.branch,
        fencingToken: warrant.fencingToken,
        leaseGeneration: warrant.generation,
        leaseSeconds: options.leaseSeconds,
        execute: true,
        token: options.token,
        apiUrl: options.apiUrl,
      });
    },
  });
  writeEvidence(
    `native-heartbeat-attempt-${attempt}.json`,
    nativeExecutionReceipt,
  );
  await client.exactPullRequestHead(
    options.pullRequestNumber,
    options.expectedHead,
  );
  const proof = createNativeQualificationProof({
    repository: options.repository,
    protectedBase: options.branch,
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    environmentRoot: options.environmentRoot,
    sourceHead: options.expectedHead,
    qualifiedBase,
    nativeExecutionReceipt,
    affectedPaths: options.affectedPaths,
    shardEvidenceRoots: [
      ...options.shardEvidenceRoots,
      nativeExecutionReceipt.receiptRoot,
    ],
    qualifiedAt: new Date().toISOString(),
  });
  writeEvidence("native-proof.json", proof);
  return proof;
}
