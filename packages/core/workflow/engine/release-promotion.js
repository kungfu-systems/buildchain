import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { exactObject, fail } from "./identity.js";
import { planReleaseRoute } from "../../release/release-invocation.js";
import { selectRecoveredProductPublicationVersion } from "../universal-workflow-bootstrap.js";
import { assertDeclarativePromotionInputs } from "../../publication/publication-qualification.js";
import { normalizePromotionRequest } from "../../release/promotion-request.js";
import { qualifyPromotionCandidate } from "../../release/promotion/candidate.js";
import { materializePublicationIntent } from "../../release/candidate/publication-intent.js";
import { publishWithDiscussion } from "../../release/discussion/publication.js";
import { selectedRecordRuntime } from "../../release/discussion/session.js";
import {
  observeReleaseRoute,
  observedSourceTimestamp,
  observeProductPublicationRecovery,
} from "./release-observation.js";
import {
  prepareTrustedPublishingNpm,
  prepareReleaseConsumerDependencies,
} from "./release-environment.js";
import { verifiedReleaseDocuments } from "./release-evidence.js";
async function materializeProductPublicationIntent(
  { candidate, inputs, repository, route },
  context,
) {
  const intentPath = path.resolve(
    ".buildchain/release-candidate/product-publication-intent.json",
  );
  const sourceTimestamp = await observedSourceTimestamp(
    repository,
    route.requestedSha,
    context,
  );
  const version = String(
    candidate.publicationVersion || candidate.version || "",
  ).trim();
  const explicitResume = Boolean(
    inputs["resume-transaction-id"] || inputs["resume-discussion-id"],
  );
  const recovery =
    route.decision !== "Resume" || explicitResume
      ? {}
      : await observeProductPublicationRecovery(
          repository,
          route.requestedSha,
          version,
          route.channel,
          context,
        );
  const recoveredVersion = inputs["resume-discussion-id"]
    ? version
    : selectRecoveredProductPublicationVersion({
        routeDecision: route.decision,
        candidateVersion: version,
        channel: route.channel,
        requestedSha: route.requestedSha,
        explicitResume,
        ...recovery,
      });
  materializePublicationIntent({
    repository,
    channel: route.channel,
    targetRef: route.targetRef,
    sourceSha: route.requestedSha,
    sourceTimestamp,
    candidateVersion: version,
    recoveredVersion,
    manifestPath: candidate.paths.sealedBundleManifest,
    requiredArtifactsPath: candidate.paths.publishRequiredArtifacts,
    artifactKind: inputs["publish-artifact-kind"] || "npm",
    packageName: inputs["publish-package-main"],
    distTag: inputs["publish-dist-tag"],
    outputPath: intentPath,
  });
  return intentPath;
}
export async function executeReleasePromotion(request, admission, context) {
  let payload = request.payload;
  exactObject(
    payload,
    ["schema", "inputs", "dryRunObservation"],
    "release promotion payload",
  );
  if (payload.schema !== "kungfu-buildchain-v4-universal-release-promotion/v1")
    fail("release promotion payload schema is unsupported");
  exactObject(
    payload.inputs,
    Object.keys(payload.inputs),
    "release promotion inputs",
  );
  payload = { ...payload, inputs: normalizePromotionRequest(payload.inputs) };
  assertDeclarativePromotionInputs(payload.inputs);
  const repository = request.consumer.repository;
  const targetRef = String(payload.inputs["target-ref"] || "").replace(
    /^refs\/heads\//u,
    "",
  );
  const requestedSha = String(
    payload.inputs["target-sha"] || request.consumer.sourceSha,
  );
  let route;
  if (payload.inputs["dry-run"] === true && payload.dryRunObservation) {
    exactObject(
      payload.dryRunObservation,
      ["observedSha", "comparisonStatus"],
      "dry-run observation",
    );
    route = planReleaseRoute({
      requestedSha,
      observedSha: payload.dryRunObservation.observedSha,
      comparisonStatus: payload.dryRunObservation.comparisonStatus,
      requestedChannel: payload.inputs.channel,
      targetRef,
      dryRun: true,
      resume: false,
    });
  } else {
    route = await observeReleaseRoute(
      {
        repository,
        targetRef,
        requestedSha,
        inputs: payload.inputs,
      },
      context,
    );
  }
  if (route.decision === "Blocked")
    fail(`release route blocked: ${route.reason}`);
  if (route.decision === "NoOp" || payload.inputs["dry-run"] === true)
    return { route, dryRun: payload.inputs["dry-run"] === true };
  prepareReleaseConsumerDependencies();
  if (payload.inputs["trusted-publishing"] === true)
    prepareTrustedPublishingNpm();
  const candidate = await qualifyPromotionCandidate({
    request: payload.inputs,
    intent: {
      "target-ref": route.targetRef,
      "requested-sha": route.requestedSha,
      channel: route.channel,
    },
    repository,
    token: context.token,
    apiUrl: context.apiUrl,
    runtimeSha: admission.runtime.sha,
    runtimeRoot: context.runtimeRoot,
    recoveryRunId: context.runId,
    recoveryRunAttempt: context.runAttempt,
    outputDir: path.resolve(".buildchain/release-candidate"),
  });
  if (!candidate.enabled)
    fail(candidate.reason || "release candidate is unavailable");
  const productPublicationIntentPath =
    await materializeProductPublicationIntent(
      {
        candidate,
        inputs: payload.inputs,
        repository,
        route,
      },
      context,
    );
  const productPublicationIntent = JSON.parse(
    fs.readFileSync(productPublicationIntentPath),
  );
  const runtimeTree = execFileSync(
    "git",
    ["-C", context.runtimeRoot, "rev-parse", "HEAD^{tree}"],
    { encoding: "utf8" },
  ).trim();
  const publicationRequest = {
    token: context.token,
    "mutation-token": context.mutationToken || context.token,
    repository,
    "source-sha": route.requestedSha,
    version: productPublicationIntent.version,
    tag: productPublicationIntent.exactTag,
    channel: route.channel,
    "target-ref": route.targetRef,
    "target-sha": route.requestedSha,
    "candidate-passport-path": candidate.paths.passport,
    "candidate-build-summary-path": candidate.paths.buildSummary,
    "stage-capsules-path": candidate.paths.stageCapsules,
    "publication-qualification-path": candidate.paths.publicationQualification,
    "publish-artifact-kind": payload.inputs["publish-artifact-kind"] || "npm",
    "sealed-bundle-root": candidate.paths.sealedBundleRoot,
    "sealed-bundle-manifest": candidate.paths.sealedBundleManifest,
    "required-artifacts-path": candidate.paths.publishRequiredArtifacts,
    "product-publication-intent-path": productPublicationIntentPath,
    "publisher-workflow-sha": admission.runtime.sha,
    "runtime-commit": admission.runtime.sha,
    "runtime-tree": runtimeTree,
    "required-status-check": payload.inputs["required-status-check"],
    "publish-command": payload.inputs["publish-command"],
    "publish-mode": payload.inputs["publish-mode"],
    "publish-dist-tag": payload.inputs["publish-dist-tag"],
    "publish-package-set-order": payload.inputs["publish-package-set-order"],
    "publish-package-main": payload.inputs["publish-package-main"],
    "publish-auth": payload.inputs["trusted-publishing"]
      ? "trusted-publishing"
      : "npm-token",
    "publish-rematerialize-on-resume":
      payload.inputs["publish-rematerialize-on-resume"],
    "publish-transaction-override":
      payload.inputs["publish-transaction-override"],
    "resume-transaction-id": payload.inputs["resume-transaction-id"],
    "resume-discussion-id": payload.inputs["resume-discussion-id"],
    "standalone-binary-distribution":
      payload.inputs["standalone-binary-distribution"],
    "artifact-paths": candidate.paths.releaseAssets,
    "state-path": ".buildchain/release-tail/state.json",
    "failure-after-capability":
      payload.inputs["provider-failure-after-capability"],
  };
  const provider = await publishWithDiscussion(publicationRequest, {
    runtime: selectedRecordRuntime({
      BUILDCHAIN_RUNTIME_SELECTION: context.runtimeSelection,
      BUILDCHAIN_RUNTIME_ROOT: context.runtimeRoot,
    }),
    workspace: process.cwd(),
    runtimeRoot: context.runtimeRoot,
    attempt: `${context.runId}:${context.runAttempt || "1"}:bootstrap`,
    octokit: context.octokit,
    mutationOctokit: context.mutationOctokit,
    actor: context.actor,
    runId: context.runId,
  });
  return {
    route,
    candidate: {
      runId: candidate.run.id,
      sourceSha: candidate.artifacts.sourceSha,
      version: candidate.version,
    },
    provider: provider.outputs,
    release: verifiedReleaseDocuments(),
  };
}
