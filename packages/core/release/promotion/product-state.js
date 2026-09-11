import {
  productStateVersion,
  selectFinalizedProductPublicationVersion,
  selectRecoveredProductPublicationVersion,
} from "../../workflow/universal-workflow-bootstrap.js";
export async function classifyProductPublication(
  { requestedSha, targetRef },
  reader,
) {
  const head = await reader.commit(requestedSha),
    recoveryStates = [];
  for (const stateRef of await reader.states()) {
    const match = stateRef.ref.match(
      /^refs\/heads\/buildchain\/v4-product-state\/([0-9a-f]{40})-/u,
    );
    if (!match) continue;
    const stateCommit = await reader.commit(stateRef.object.sha);
    if (stateCommit.tree?.sha !== head.tree?.sha) continue;
    const headComparisonStatus = await reader.compare(
      stateRef.object.sha,
      requestedSha,
    );
    const version = productStateVersion(stateRef, match[1]);
    recoveryStates.push({
      stateRef,
      stateCommit,
      exactTagRef: await reader.tag(version),
      headComparisonStatus,
    });
  }
  const finalizedVersion = selectFinalizedProductPublicationVersion({
    requestedSha,
    requestedTree: head.tree.sha,
    targetRef,
    recoveryStates,
  });
  return {
    action: finalizedVersion ? "noop" : "promote",
    "finalized-version": finalizedVersion,
  };
}
export async function recoverProductPublicationVersion(
  { requestedSha, candidateVersion, explicitResume },
  reader,
) {
  const recoveryStates = [];
  if (!explicitResume)
    for (const stateRef of await reader.candidateStates(requestedSha)) {
      const version = productStateVersion(stateRef, requestedSha);
      recoveryStates.push({
        stateRef,
        stateCommit: await reader.commit(stateRef.object.sha),
        exactTagRef: await reader.tag(version),
      });
    }
  const exactTagRef =
    !explicitResume && recoveryStates.length === 0
      ? await reader.tag(candidateVersion)
      : undefined;
  return selectRecoveredProductPublicationVersion({
    routeDecision: "Resume",
    candidateVersion,
    requestedSha,
    explicitResume,
    recoveryStates,
    exactTagRef,
  });
}
