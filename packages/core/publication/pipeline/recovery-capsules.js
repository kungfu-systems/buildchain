import { recordDigest } from "../../release/discussion/envelope.js";
import {
  validateStageCapsule,
  stageCapsuleIdentityRoot,
  stageCapsuleRoot,
} from "../../build/stage-capsule.js";
import { verifyRootedPublication } from "./documents.js";

export function requalifyPublicationCapsules(previous, qualified, plan) {
  verifyRootedPublication(previous, "buildchain.pipeline-product-capsules/v1");
  if (
    recordDigest(previous.capsules.map((item) => item.artifact)) !==
    recordDigest(qualified.artifacts)
  )
    throw new Error(
      "Recovery capsules changed the exact sealed artifact inventory",
    );
  const capsules = previous.capsules.map((entry) => {
    validateStageCapsule(entry.capsule);
    const identity = {
      ...entry.capsule.identity,
      qualificationRoot: qualified.qualification.receiptRoot,
      declaredInputs: [
        { name: "predecessor-capsule", root: entry.capsule.capsuleRoot },
        { name: "publication-plan", root: plan.root },
      ],
      observationRoots: [
        { name: "provider-build", root: qualified.build.root },
      ],
    };
    // Retain the producer's runtime and original retention promise, even when
    // expired. The current sealed-byte readback supplies publication authority;
    // this derived capsule does not invent a renewed Actions artifact lease.
    const capsule = {
      ...entry.capsule,
      identity,
      identityRoot: stageCapsuleIdentityRoot(identity),
    };
    capsule.capsuleRoot = stageCapsuleRoot(capsule);
    validateStageCapsule(capsule);
    return {
      ...entry,
      capsule,
      predecessorCapsuleRoot: entry.capsule.capsuleRoot,
    };
  });
  const body = {
    schema: "buildchain.pipeline-product-capsules/v1",
    qualificationRoot: qualified.root,
    predecessorRoot: previous.root,
    capsules,
  };
  return { ...body, root: recordDigest(body) };
}
