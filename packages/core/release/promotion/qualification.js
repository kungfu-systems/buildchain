import path from "node:path";
import { assertDeclarativePromotionInputs } from "../../publication/publication-qualification.js";
import { materializePublicationIntent } from "../candidate/publication-intent.js";
import { qualifyPromotionSource } from "./source-intent.js";
import { qualifyPromotionCandidate } from "./candidate.js";
import { recoverProductPublicationVersion } from "./product-state.js";
export async function qualifyPromotion(
  { request, repository, sourceSha, sourceRef, workspace, ...runtime },
  reader,
  {
    source = qualifyPromotionSource,
    candidate = qualifyPromotionCandidate,
    recoverVersion = recoverProductPublicationVersion,
    publication = materializePublicationIntent,
  } = {},
) {
  const intent = await source(
    {
      requestedSha: request["target-sha"] || sourceSha,
      targetRef: (request["target-ref"] || sourceRef).replace(
        /^refs\/heads\//u,
        "",
      ),
      requestedChannel: request.channel,
      dryRun: request["dry-run"],
      resume: Boolean(
        request["resume-discussion-id"] ||
        request["resume-candidate-run-id"] ||
        request["publish-transaction-override"],
      ),
    },
    reader,
  );
  if (intent.action !== "promote") return intent;
  assertDeclarativePromotionInputs(request);
  const outputDir = path.join(workspace, ".buildchain/release-candidate"),
    qualified = await candidate({
      request,
      intent,
      repository,
      outputDir,
      ...runtime,
    });
  if (!qualified.enabled)
    throw new Error(
      `Promotion candidate was not qualified: ${qualified.reason || "missing evidence"}`,
    );
  const candidateVersion = qualified.candidateVersion || qualified.version,
    publicationVersion = qualified.publicationVersion || qualified.version;
  const recoveredVersion = request["resume-discussion-id"]
    ? publicationVersion
    : request["publish-transaction-override"] ||
        request["resume-transaction-id"]
      ? await recoverVersion(
          {
            requestedSha: intent["requested-sha"],
            candidateVersion: publicationVersion,
            explicitResume: Boolean(request["resume-transaction-id"]),
          },
          reader,
        )
      : "";
  const rooted = publication({
    artifactKind: request["publish-artifact-kind"],
    packageName: request["publish-package-main"],
    sourceSha: intent["requested-sha"],
    manifestPath: qualified.paths.sealedBundleManifest,
    requiredArtifactsPath: qualified.paths.publishRequiredArtifacts,
    channel: intent.channel,
    targetRef: intent["target-ref"],
    sourceTimestamp: intent["source-timestamp"],
    repository,
    distTag: request["publish-dist-tag"],
    candidateVersion: publicationVersion,
    recoveredVersion,
    outputPath: path.join(outputDir, "product-publication-intent.json"),
  });
  return {
    ...intent,
    version: rooted.intent.version,
    "exact-tag": rooted.intent.exactTag,
    "candidate-version": candidateVersion,
    "product-publication-intent-path": rooted.outputPath,
    "product-publication-intent-root": rooted.intent.intentRoot,
    "candidate-source-sha": qualified.artifacts.sourceSha,
    "candidate-artifact": qualified.artifacts.passport,
    "candidate-passport-path": qualified.paths.passport,
    "candidate-build-summary-path": qualified.paths.buildSummary,
    "stage-capsules-path": qualified.paths.stageCapsules || "",
    "publication-qualification-path":
      qualified.paths.publicationQualification || "",
    "sealed-bundle-root": qualified.paths.sealedBundleRoot,
    "sealed-bundle-manifest": qualified.paths.sealedBundleManifest,
    "recovery-receipt-path": qualified.paths.recoveryReceipt || "",
    "required-artifacts-path": qualified.paths.publishRequiredArtifacts,
    "release-artifact-paths": (qualified.paths.releaseAssets || []).join("\n"),
  };
}
