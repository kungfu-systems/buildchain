export function alphaCandidateOutputs(options, result) {
  return {
    "result-path": options.outputPath,
    eligible: String(result.decision.eligible),
    "selected-sha": result.decision.source.sha,
    "source-lock-ref": result.decision.sourceLockRef || "",
    "promotion-pr": result.pullRequest?.html_url || "",
    "controller-state": result.controller.state,
    "active-candidate-pr": result.controller.activeCandidate?.url || "",
    "next-candidate-sha": result.controller.nextCandidate?.sourceSha || "",
    "settlement-action": result.controller.settlementAction,
    "prior-state-root": result.controller.priorStateRoot,
    "train-root": result.controller.trainRoot || "",
    "cut-root": result.controller.cutRoot || "",
    "candidate-generation": String(result.controller.generation),
    "candidate-tree-sha": result.controller.candidateTreeSha || "",
    "runtime-sha": result.controller.buildchainRuntimeSha || "",
    "cut-created-at": result.controller.cutCreatedAt || "",
    "observed-at": result.controller.observedAt || "",
    "drift-root": result.drift?.observationRoot || "",
    "hold-root": result.controller.holdRoot || "",
  };
}
