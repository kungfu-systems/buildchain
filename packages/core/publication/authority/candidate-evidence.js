import fs from "node:fs";
import path from "node:path";
import { createPublicationArtifactManifestSet } from "../publication-authority.js";
import { filesNamed, one, payloadFor } from "./evidence.js";
export function collectCandidateAdmissionEvidence({
  evidenceRoot,
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
}) {
  const passport = one(
    path.join(evidenceRoot, "passport"),
    "release-candidate-passport.json",
  );
  const controllerReceipt = one(
    path.join(evidenceRoot, "controller"),
    "release-candidate-receipt.json",
  );
  if (!sourceTreeSha || sourceTreeSha !== passport.source?.treeHash)
    throw new Error(
      `admitted source tree does not match release candidate: ${sourceTreeSha || "missing"}`,
    );
  const manifests = filesNamed(
    path.join(evidenceRoot, "manifests"),
    "manifest.json",
  ).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const artifactSet = createPublicationArtifactManifestSet({
    repository,
    sourceSha: passport.source?.headSha,
    sourceTreeSha,
    manifests,
    payloads: manifests.map((manifest) =>
      payloadFor(manifest, path.join(evidenceRoot, "payloads")),
    ),
  });
  return {
    controllerReceipt,
    runtimeSha,
    artifactDigest: artifactSet.manifestSetDigest,
  };
}
