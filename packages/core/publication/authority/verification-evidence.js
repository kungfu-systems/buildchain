import fs from "node:fs";
import path from "node:path";
import { filesNamed, one, sha256File, payloadFor } from "./evidence.js";
import { buildPublicationArtifactCandidate } from "../candidate/artifact.js";
export function publicationVerificationEvidence({
  kind,
  evidenceRoot,
  sourceTreeSha,
  runtimeSha,
  admission,
  gateAggregate,
}) {
  let publicationEvidence;
  if (kind === "binary-release-assets") {
    const bundleManifest = one(
      path.join(evidenceRoot, "binary-passport"),
      "buildchain-release-bundle.json",
    );
    const bundleArchive = filesNamed(
      path.join(evidenceRoot, "binary-passport"),
      "buildchain-release-bundle.tar.gz",
    );
    if (bundleArchive.length !== 1) {
      throw new Error(
        `expected exactly one buildchain-release-bundle.tar.gz, found ${bundleArchive.length}`,
      );
    }
    publicationEvidence = {
      binaryReleaseEvidence: {
        sourceTreeSha: sourceTreeSha,
        bundleManifest,
        bundleArchiveDigest: sha256File(bundleArchive[0]),
        controllerReceipt: one(
          path.join(evidenceRoot, "binary-controller"),
          "receipt.json",
        ),
      },
      gateAggregate: gateAggregate,
    };
  } else if (kind === "publication-artifact") {
    const candidateBundle = buildPublicationArtifactCandidate({
      artifactRoot: path.join(evidenceRoot, "artifact"),
      controllerRoot: path.join(evidenceRoot, "controller"),
      repository: admission.repository,
      sourceSha: admission.sourceSha,
      sourceTreeSha: sourceTreeSha,
      runtimeSha: runtimeSha,
    });
    publicationEvidence = {
      publicationArtifactCandidate: candidateBundle.evidence,
      gateAggregate: gateAggregate,
    };
  } else {
    const artifactManifests = filesNamed(
      path.join(evidenceRoot, "manifests"),
      "manifest.json",
    ).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    publicationEvidence = {
      sourceTreeSha: sourceTreeSha,
      releaseCandidatePassport: one(
        path.join(evidenceRoot, "passport"),
        "release-candidate-passport.json",
      ),
      buildSummary: one(
        path.join(evidenceRoot, "summary"),
        "build-summary.json",
      ),
      controllerReceipt: one(
        path.join(evidenceRoot, "controller"),
        "release-candidate-receipt.json",
      ),
      gateAggregate: gateAggregate,
      artifactManifests,
      artifactPayloads: artifactManifests.map((manifest) =>
        payloadFor(manifest, path.join(evidenceRoot, "payloads")),
      ),
    };
  }
  return publicationEvidence;
}
