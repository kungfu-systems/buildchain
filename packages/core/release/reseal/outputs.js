export function tailPlanOutputs(request, plan, output) {
  return {
    "plan-root": plan.planRoot,
    "plan-path": output,
    "source-run-id": request.source.runId,
    "source-run-attempt": request.source.runAttempt,
    "source-sha": request.source.sha,
    "source-tree-sha": request.source.treeSha,
    "runtime-sha": request.runtime.sha,
    "consumer-policy-receipt-root": request.runtime.consumerPolicyReceiptRoot,
    "warrant-readback-root": request.warrant.stateReadbackRoot,
    "signing-provider-readback-root": request.signing.providerReadbackRoot,
    "release-tail-provider-readback-root":
      request.releaseTail.providerReadbackRoot,
    "signing-authority-repository": request.signing.authorityRepository,
    "signing-authority-run-id": request.signing.authorityRunId,
    "signing-result-artifact": request.signing.resultArtifact,
    "target-version": request.target.version,
    "platforms-json": JSON.stringify(request.platforms),
  };
}
