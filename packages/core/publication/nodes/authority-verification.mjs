import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { verifyPublicationAdmission } from "../publication-authority.js";
import {
  filesNamed,
  one,
  sha256File,
  payloadFor,
} from "./authority-evidence.mjs";
import { buildPublicationArtifactCandidate } from "../commands/publication-artifact-candidate.mjs";

export async function verifySealedAdmission(
  env,
  { request = fetch, execute = execFileSync } = {},
) {
  const parse = (name) => JSON.parse(env[name]);
  const admission = parse("BUILDCHAIN_PUBLICATION_ADMISSION_JSON");
  const actualRuntimeSha = execute(
    "git",
    ["-C", ".buildchain/authority-runtime", "rev-parse", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .toLowerCase();
  const expectedAuthorityRuntimeSha =
    env.BUILDCHAIN_AUTHORITY_REF.toLowerCase();
  if (actualRuntimeSha !== expectedAuthorityRuntimeSha) {
    throw new Error(
      `authority runtime checkout mismatch: expected ${expectedAuthorityRuntimeSha}, got ${actualRuntimeSha}`,
    );
  }
  const response = await request(
    `${env.GITHUB_API_URL}/repos/${admission.repository}/git/commits/${admission.sourceSha}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `could not resolve admitted source tree: GitHub API ${response.status}`,
    );
  const commit = await response.json();
  let publicationEvidence;
  if (env.BUILDCHAIN_AUTO_ADMISSION_KIND === "binary-release-assets") {
    const bundleManifest = one(
      ".buildchain/publication-evidence/binary-passport",
      "buildchain-release-bundle.json",
    );
    const bundleArchive = filesNamed(
      ".buildchain/publication-evidence/binary-passport",
      "buildchain-release-bundle.tar.gz",
    );
    if (bundleArchive.length !== 1) {
      throw new Error(
        `expected exactly one buildchain-release-bundle.tar.gz, found ${bundleArchive.length}`,
      );
    }
    publicationEvidence = {
      binaryReleaseEvidence: {
        sourceTreeSha: commit.tree?.sha,
        bundleManifest,
        bundleArchiveDigest: sha256File(bundleArchive[0]),
        controllerReceipt: one(
          ".buildchain/publication-evidence/binary-controller",
          "receipt.json",
        ),
      },
      gateAggregate: parse("BUILDCHAIN_GATE_AGGREGATE_JSON"),
    };
  } else if (env.BUILDCHAIN_AUTO_ADMISSION_KIND === "publication-artifact") {
    const candidateBundle = buildPublicationArtifactCandidate({
      artifactRoot: ".buildchain/publication-evidence/artifact",
      controllerRoot: ".buildchain/publication-evidence/controller",
      repository: admission.repository,
      sourceSha: admission.sourceSha,
      sourceTreeSha: commit.tree?.sha,
      runtimeSha: actualRuntimeSha,
    });
    publicationEvidence = {
      publicationArtifactCandidate: candidateBundle.evidence,
      gateAggregate: parse("BUILDCHAIN_GATE_AGGREGATE_JSON"),
    };
  } else {
    const artifactManifests = filesNamed(
      ".buildchain/publication-evidence/manifests",
      "manifest.json",
    ).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    publicationEvidence = {
      sourceTreeSha: commit.tree?.sha,
      releaseCandidatePassport: one(
        ".buildchain/publication-evidence/passport",
        "release-candidate-passport.json",
      ),
      buildSummary: one(
        ".buildchain/publication-evidence/summary",
        "build-summary.json",
      ),
      controllerReceipt: one(
        ".buildchain/publication-evidence/controller",
        "release-candidate-receipt.json",
      ),
      gateAggregate: parse("BUILDCHAIN_GATE_AGGREGATE_JSON"),
      artifactManifests,
      artifactPayloads: artifactManifests.map(payloadFor),
    };
  }
  const capability = verifyPublicationAdmission({
    admission,
    registry: JSON.parse(
      fs.readFileSync(
        ".buildchain/authority-runtime/dist/site/publication-authority-registry.json",
        "utf8",
      ),
    ),
    runnerProvenance: parse("BUILDCHAIN_RUNNER_PROVENANCE_JSON"),
    controlPlaneAudit: parse("BUILDCHAIN_CONTROL_PLANE_AUDIT_JSON"),
    publicationEvidence,
    expected: parse("BUILDCHAIN_PUBLICATION_EXPECTED_JSON"),
    usedNonces: parse("BUILDCHAIN_USED_NONCES_JSON"),
  });
  validateCapabilityBinding(capability, env, actualRuntimeSha);
  fs.mkdirSync(".buildchain/publication-authority", { recursive: true });
  fs.writeFileSync(
    ".buildchain/publication-authority/capability.json",
    `${JSON.stringify(capability, null, 2)}\n`,
  );
  fs.writeFileSync(
    ".buildchain/publication-authority/gate-aggregate.json",
    `${JSON.stringify(publicationEvidence.gateAggregate, null, 2)}\n`,
  );
}

export function validateCapabilityBinding(capability, env, actualRuntimeSha) {
  if (
    env.BUILDCHAIN_AUTO_ADMISSION_KIND !== "binary-release-assets" &&
    capability.runtimeSha !== actualRuntimeSha
  ) {
    throw new Error(
      `authority runtime checkout mismatch: expected ${capability.runtimeSha}, got ${actualRuntimeSha}`,
    );
  }
  if (capability.version !== env.BUILDCHAIN_PLANNED_PUBLICATION_VERSION) {
    throw new Error(
      `authority publication version mismatch: planned ${env.BUILDCHAIN_PLANNED_PUBLICATION_VERSION || "<empty>"}, capability ${capability.version || "<empty>"}`,
    );
  }
  const qualificationRequired =
    env.BUILDCHAIN_CONSUMER_QUALIFICATION_REQUIRED === "true";
  if (typeof capability.qualification?.required !== "boolean")
    throw new Error(
      "authority capability must declare its qualification requirement",
    );
  const capabilityQualificationRequired = capability.qualification.required;
  if (capabilityQualificationRequired !== qualificationRequired) {
    throw new Error("authority consumer qualification requirement mismatch");
  }
  if (
    qualificationRequired &&
    (capability.qualification.predicateId !==
      env.BUILDCHAIN_CONSUMER_PREDICATE_ID ||
      capability.qualification.predicateDigest !==
        env.BUILDCHAIN_CONSUMER_PREDICATE_DIGEST)
  ) {
    throw new Error("authority consumer predicate binding mismatch");
  }
}
