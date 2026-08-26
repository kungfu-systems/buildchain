import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";
import path from "node:path";

import { publishDeclarativeGitHubReleaseEvidence } from "../promote-buildchain-ref/github-release.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";
import { v4ContentRoot } from "../../packages/core/v4-canonical-contracts.js";
import {
  v4PublicationQualificationRoot,
  validateV4PublicationQualificationReceipt,
} from "../../packages/core/v4-publication-qualification.js";

const input = (name, required = false) =>
  core.getInput(name, { required }).trim();
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const write = (file, value) => {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
};

export function aggregateV4ReleasePassport({
  candidate,
  stageCapsules,
  qualification,
  version,
  tag,
  channel,
}) {
  const artifacts = stageCapsules.capsules.map(
    ({ publicationArtifact }) => publicationArtifact,
  );
  validateV4PublicationQualificationReceipt(qualification, {
    repository: candidate.repository,
    candidateRoot: `sha256:${candidate.candidateHash}`,
    sourceSha: candidate.source?.headSha,
    sourceRoot: v4ContentRoot("candidate-identity", candidate.source),
    artifactRoot: v4PublicationQualificationRoot(artifacts),
    policyDigest: candidate.consumerPolicy?.receiptRoot,
  });
  if (stageCapsules.publicationQualificationRoot !== qualification.receiptRoot)
    throw new Error(
      "Stage Capsule aggregate does not bind publication qualification",
    );
  const body = {
    schema: "kungfu.buildchain.release-passport/v4",
    repository: candidate.repository,
    source: candidate.source,
    release: { version, tag, channel },
    candidateRoot: qualification.candidateRoot,
    policyDigest: qualification.policyDigest,
    artifactRoot: qualification.artifactRoot,
    publicationQualificationRoot: qualification.receiptRoot,
    stageCapsuleAggregateRoot: stageCapsules.root,
    stageCapsuleRoots: stageCapsules.capsules
      .map(({ capsule }) => capsule.capsuleRoot)
      .sort(),
  };
  return { ...body, passportRoot: releaseTailRoot(body) };
}

async function main() {
  const repository = input("repository", true);
  const sourceSha = input("source-sha", true);
  const version = input("version", true);
  const tag = input("tag", true);
  const channel = input("channel", true);
  const candidate = read(input("candidate-passport-path", true));
  const stageCapsules = read(input("stage-capsules-path", true));
  const qualification = read(input("publication-qualification-path", true));
  if (
    candidate.repository !== repository ||
    candidate.source?.headSha !== sourceSha
  )
    throw new Error("candidate repository/source binding mismatch");
  if (
    stageCapsules.repository !== repository ||
    stageCapsules.source?.sha !== sourceSha
  )
    throw new Error("Stage Capsule repository/source binding mismatch");
  const passport = aggregateV4ReleasePassport({
    candidate,
    stageCapsules,
    qualification,
    version,
    tag,
    channel,
  });
  const outputDir = path.resolve(".buildchain/release-passport");
  const passportPath = write(
    path.join(outputDir, "buildchain.release.json"),
    passport,
  );
  const evidencePath = write(
    ".buildchain/release-tail/publication-evidence.json",
    {
      schema: "kungfu.buildchain.v4-publication-evidence/v1",
      repository,
      sourceSha,
      tag,
      channel,
      candidateRoot: qualification.candidateRoot,
      qualificationRoot: qualification.receiptRoot,
      releasePassportRoot: passport.passportRoot,
    },
  );
  const result = await publishDeclarativeGitHubReleaseEvidence({
    octokit: github.getOctokit(input("token", true)),
    repository,
    sourceSha,
    version,
    tag,
    channel,
    publishEvidencePath: evidencePath,
    releasePassportPath: passportPath,
    releasePassportOutputDir: outputDir,
    additionalAssetPaths: core
      .getMultilineInput("artifact-paths")
      .filter(Boolean),
    statePath: input("state-path") || ".buildchain/release-tail/state.json",
    qualificationRoot: qualification.receiptRoot,
    failureAfterCapability: input("failure-after-capability"),
  });
  core.setOutput("release-passport-path", passportPath);
  core.setOutput("release-passport-root", passport.passportRoot);
  core.setOutput("transaction-state", result.transaction.state);
  core.setOutput("declaration-root", result.declarationRoot);
  core.setOutput("transaction-root", result.transaction.transactionRoot);
  core.setOutput("state-root", result.transaction.stateRoot);
  core.setOutput(
    "receipt-roots-json",
    JSON.stringify(
      result.transaction.receipts.map(({ receiptRoot }) => receiptRoot),
    ),
  );
}

main().catch((error) => core.setFailed(error.message));
