import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import { decodeRecord } from "./envelope.js";
import { releaseDiscussionStore } from "./store.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";
import { releaseCheckpoints, restoreRecoveryMaterials } from "./checkpoints.js";
import { validateReleaseCandidatePassport } from "../release-candidate.js";
import {
  assertCandidateEvidenceBinding,
  aggregateReleasePassport,
  observeProtectedPublicationSource,
} from "../promote-candidate/evidence-binding.js";

export async function recoverDiscussionCandidate({
  discussionId,
  repository,
  token,
  outputDir,
  targetSha,
  targetRef,
}) {
  const octokit = getOctokit(token);
  const transport = discussionTransport(octokit.graphql);
  const discussion = await transport.get(discussionId);
  const intent = decodeRecord(discussion.body);
  if (
    intent?.repository !== repository ||
    discussion.author?.login !== "github-actions[bot]"
  )
    throw new Error(
      "Recovery requires the consumer workflow's original Discussion",
    );
  const session = { discussion, intent, writerId: discussion.author.id };
  const store = releaseDiscussionStore(transport);
  const observed = await store.read(session);
  const snapshots = observed.records
    .filter(
      (record) =>
        record.kind === "checkpoint" && record.node === "qualification",
    )
    .sort(
      (a, b) =>
        observed.attempts.indexOf(b.attempt) -
          observed.attempts.indexOf(a.attempt) || b.sequence - a.sequence,
    );
  if (!snapshots.length)
    throw new Error("Discussion has no retained qualified recovery material");
  const retained = releaseCheckpoints({ session, store, octokit });
  const manifest = await retained.readCheckpoint(snapshots[0]);
  if (
    manifest.source?.repository !== repository ||
    manifest.source.version !== intent.key ||
    manifest.source.targetRef !== targetRef
  )
    throw new Error("Recovery material belongs to a different release intent");
  const workspace = path.resolve(outputDir, "../..");
  const prefix =
    path
      .relative(workspace, path.resolve(outputDir))
      .split(path.sep)
      .join("/") + "/";
  if (!manifest.files.every((file) => file.path.startsWith(prefix)))
    throw new Error(
      "Candidate recovery cannot restore files outside its evidence directory",
    );
  const inputs = await restoreRecoveryMaterials(
    manifest,
    workspace,
    retained.materials,
  );
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const candidate = read(inputs["candidate-passport-path"]),
    summary = read(inputs["candidate-build-summary-path"]);
  const validation = validateReleaseCandidatePassport({
    passport: candidate,
    repository,
    buildSummary: summary,
  });
  if (!validation.ok)
    throw new Error(
      `Recovered candidate is invalid: ${validation.errors.join("; ")}`,
    );
  const stageCapsules = read(inputs["stage-capsules-path"]),
    qualification = read(inputs["publication-qualification-path"]);
  assertCandidateEvidenceBinding({ candidate, stageCapsules, repository });
  const sourceBinding = await observeProtectedPublicationSource({
    octokit,
    repository,
    protectedSourceSha: targetSha,
    candidate,
  });
  aggregateReleasePassport({
    candidate,
    stageCapsules,
    qualification,
    sourceBinding,
    version: intent.key,
    tag: `v${intent.key}`,
    channel: manifest.source.channel,
  });
  // The shared candidate provider performs artifact-kind-specific sealed verification
  // before effects; transport restoration verifies every retained file digest.
  const paths = {
    passport: inputs["candidate-passport-path"],
    buildSummary: inputs["candidate-build-summary-path"],
    stageCapsules: inputs["stage-capsules-path"],
    publicationQualification: inputs["publication-qualification-path"],
    sealedBundleRoot: inputs["sealed-bundle-root"],
    sealedBundleManifest: inputs["sealed-bundle-manifest"],
    publishRequiredArtifacts: inputs["required-artifacts-path"],
    recoveryReceipt: inputs["recovery-receipt-path"] || "",
    releaseAssets: (manifest.releaseAssets || []).map((file) =>
      path.resolve(workspace, file),
    ),
  };
  return {
    enabled: true,
    version: candidate.target.version,
    publicationVersion: intent.key,
    candidateVersion: candidate.target.version,
    artifacts: {
      sourceSha: candidate.source.headSha,
      passport: `discussion-${discussion.number}`,
    },
    paths,
    run: { id: snapshots[0].attempt.split(":")[0] },
    discussionId,
    handoff: observed.handoff,
  };
}
