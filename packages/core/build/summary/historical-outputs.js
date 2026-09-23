import { readJson } from "../plan/values.js";

// Project provider-confirmed evidence; this never grants publication authority.
export function historicalBuildOutputs(
  plan,
  artifacts,
  controller,
  summary,
  file,
) {
  const runtime = summary.runtime;
  const source = summary.publishSource;
  const gate = summary.publishGate;
  const json = (value) => JSON.stringify(value);
  const name = (reference) => reference?.name || "";
  const outputs = {
    "buildchain-channel": plan.identity.channel,
    "buildchain-channel-selection-source": "called-workflow",
    "buildchain-channel-reason": `Selected by ${plan.identity.ref}`,
    "runner-preset": plan.environment.runners.preset,
    "platforms-json": json(
      plan.platforms.map((platform) => ({
        ...platform,
        runner: json(platform.runner),
      })),
    ),
    "runner-routing-json": plan.routing ? json(plan.routing) : "",
    "platform-count": plan.platforms.length,
    "linux-container-enabled": plan.container.enabled,
    "linux-container-image": plan.container.image,
    "build-summary-artifact": name(artifacts.summary),
    "credential-island-macos-artifact": name(artifacts.credential?.payload),
    "credential-island-macos-manifest-artifact": name(
      artifacts.credential?.manifest,
    ),
    "build-diagnostics-summary-artifact": name(artifacts.diagnostics),
    "release-candidate-passport-artifact": name(artifacts.release_candidate),
    "release-candidate-artifact": name(artifacts.release_candidate),
    "release-candidate-passport-json": artifacts.release_candidate
      ? json(
          readJson(
            file(".buildchain/artifacts/release-candidate-passport.json"),
          ),
        )
      : "",
    "build-summary-json": json(summary),
    "artifact-coordinates-json": json(
      readJson(file(".buildchain/artifacts/artifact-coordinates.json")),
    ),
    "build-diagnostics-summary-json": json(
      readJson(file(".buildchain/artifacts/diagnostics-summary.json")),
    ),
    "trusted-event": gate.trustedEvent,
    "buildchain-runtime-ref": runtime.ref,
    "buildchain-runtime-sha": runtime.sha,
    "buildchain-runtime-class": runtime.class,
    "buildchain-runtime-override": runtime.override,
    "buildchain-runtime-trust-decision": runtime.trustDecision,
    "buildchain-contract-lock-status": plan.admission.lock_status,
    "buildchain-contract-lock-drift": plan.admission.lock_drift,
    "buildchain-contract-digest": plan.admission.contract_digest,
    "publish-channel": gate.channel,
    "publish-allowed": gate.allowed,
    "publish-reason": gate.reason,
    "publish-source-ref": source.ref,
    "publish-source-sha": source.sha,
    "publish-source-tree-sha": plan.source.tree_sha,
    "publish-source-locked": source.locked,
    "publish-source-channel": source.channel,
    "publish-source-line": source.line,
    "publish-source-consumer-version": source.consumerVersion,
    "release-manifest-json": source.releaseManifest,
    "controller-plan-artifact": name(artifacts.controller_plan),
    "controller-plan-json": json(plan.controller),
    "controller-plan-digest": plan.controller.digest,
    "controller-receipt-artifact": name(artifacts.controller_receipt),
    "controller-receipt-json": json(controller.receipt),
    "controller-receipt-digest": controller.receipt.digest,
    "controller-receipt-status": controller.receipt.status,
  };
  return Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => {
      if (value === undefined)
        throw new Error(`Missing historical build evidence: ${key}`);
      return [key, String(value)];
    }),
  );
}
