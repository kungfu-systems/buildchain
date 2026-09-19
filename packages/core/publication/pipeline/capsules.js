import { publicationArtifactProducer } from "./build-segments.js";
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
    const native = qualified.native?.platforms.find(
      (proof) => proof.platform === artifact.platform,
    );
    const producer = native
      ? { plan }
      : publicationArtifactProducer(
          qualified.build,
          artifact.providerArtifactId,
        );
    const identity = {
      schema: STAGE_CAPSULE_IDENTITY_CONTRACT,
      sourceRoot: recordDigest(qualified.source),
      platform: artifact.platform,
      platformRoot: recordDigest({ platform: artifact.platform }),
      stage: "verify",
      toolchainRoots: [],
      runtimeRoot: recordDigest(producer.plan?.runtime || plan.runtime),
      policyRoot: plan.contractRoot,
      declaredInputs: [
        { name: "publication-plan", root: producer.plan?.root || plan.root },
      ],
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
        ...(native
          ? [
              { name: "native-finalization", root: native.finalizer.root },
              { name: "native-authority", root: native.lineage.authority.root },
            ]
          : []),
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
        retainUntil: bundle.providerArtifact.expires_at.replace(
          /T(\d{2}:\d{2}:\d{2})Z$/u,
          "T$1.000Z",
        ),
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
