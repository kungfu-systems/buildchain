import { recordDigest } from "../../release/discussion/envelope.js";
import {
  STAGE_CAPSULE_CONTRACT,
  STAGE_CAPSULE_IDENTITY_CONTRACT,
  stageCapsuleIdentityRoot,
  stageCapsuleRoot,
  validateStageCapsule,
} from "../../build/stage-capsule.js";
import { verifyPipelineQualification } from "./documents.js";

export function pipelineProductCapsules({
  plan,
  materialization,
  qualified,
  bundles,
  evaluatedAt,
}) {
  verifyPipelineQualification({
    plan,
    materialization,
    qualified,
    evaluatedAt,
  });
  const capsules = qualified.artifacts.map((artifact) => {
    const bundle = bundles.find(
      ({ providerArtifact }) =>
        providerArtifact.id === artifact.providerArtifactId,
    );
    if (
      !bundle ||
      !bundle.providerArtifact.expires_at ||
      Date.parse(bundle.providerArtifact.expires_at) <=
        Date.parse(qualified.qualification.issuedAt)
    )
      throw new Error(
        "Product Capsule requires a live provider retention promise",
      );
    const identity = {
      schema: STAGE_CAPSULE_IDENTITY_CONTRACT,
      sourceRoot: recordDigest(qualified.source),
      platform: artifact.platform,
      platformRoot: recordDigest({ platform: artifact.platform }),
      stage: "verify",
      toolchainRoots: [],
      runtimeRoot: recordDigest(plan.runtime),
      policyRoot: plan.contractRoot,
      declaredInputs: [{ name: "publication-plan", root: plan.root }],
      transformationRoot: recordDigest({
        source: qualified.source,
        product: artifact.product,
        artifact: artifact.id,
        kind: artifact.kind,
      }),
      outputManifestRoot: artifact.manifestRoot,
      qualificationRoot: qualified.qualification.receiptRoot,
      observationRoots: [
        { name: "provider-build", root: qualified.build.root },
      ],
    };
    const capsule = {
      schema: STAGE_CAPSULE_CONTRACT,
      writerAuthority: "typescript-v3",
      rustAuthority: "validation-only",
      identity,
      identityRoot: stageCapsuleIdentityRoot(identity),
      retentionPromise: {
        class: "github-artifact",
        retainUntil: bundle.providerArtifact.expires_at,
      },
      capsuleRoot: `sha256:${"0".repeat(64)}`,
    };
    capsule.capsuleRoot = stageCapsuleRoot(capsule);
    validateStageCapsule(capsule);
    return { id: artifact.id, artifact, capsule };
  });
  const body = {
    schema: "buildchain.pipeline-product-capsules/v1",
    qualificationRoot: qualified.root,
    capsules,
  };
  return { ...body, root: recordDigest(body) };
}
