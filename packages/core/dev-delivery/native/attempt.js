import {
  createNativeCommandContract,
  createNativeQualificationProof,
} from "../dev-delivery-warrant.js";
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
  const commandContract = createNativeCommandContract(options.nativeCommand);
  if (
    commandContract.commandRoot !==
      warrant.nativeCommandContract?.commandRoot ||
    commandContract.commandRoot !== options.nativeCommandRoot
  ) {
    throw new Error(
      "native command does not match the authorized Warrant contract",
    );
  }
  const nativeExecutionReceipt = await runNative({
    command: options.nativeCommand,
    cwd: options.candidateDirectory,
    intervalMs: options.heartbeatSeconds * 1000,
    executionBinding: {
      repository: options.repository,
      protectedBase: options.branch,
      sourceHead: options.expectedHead,
      qualifiedBase,
      nativeCommandRoot: options.nativeCommandRoot,
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
    nativeCommandRoot: options.nativeCommandRoot,
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
