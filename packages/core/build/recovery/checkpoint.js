import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rootOf, readJson, writeJson } from "../plan/values.js";
import { verifyManifest } from "../artifact/contracts.js";

export function buildRecoveryIdentity(plan, platform) {
  return rootOf({
    source: {
      repository: plan.run.repository,
      sha: plan.source.sha,
      tree: plan.source.tree_sha,
    },
    configuration: plan.configuration_root,
    platform,
    project: plan.project,
    lifecycle: plan.lifecycle,
    tools: plan.tools,
    container: plan.container,
    environment: plan.environment,
    artifacts: plan.artifacts,
  });
}
const digestFile = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function supportFiles(plan) {
  return plan.build?.diagnostics?.sample_process_tree
    ? [
        ".buildchain/diagnostics/process-summary.json",
        ".buildchain/diagnostics/process-samples.jsonl",
      ]
    : [];
}
export const checkpointName = (platform) =>
  `buildchain-build-checkpoint-${platform.id}`;

export function sealBuildCheckpoint({ plan, platform, sourceRoot }) {
  const manifestPath = `.buildchain/artifacts/${platform.id}/manifest-build.json`;
  const file = path.join(sourceRoot, manifestPath);
  if (!fs.existsSync(file)) return null;
  const manifest = verifyManifest(file, sourceRoot, plan, platform);
  // A command without retained outputs cannot promise that another runner can
  // continue it. Its ordinary execution remains valid and will run again.
  if (!manifest.files.length) return null;
  const retainedFiles = [
    ...manifest.files.map(({ path }) => path),
    manifestPath,
    ...supportFiles(plan),
  ];
  const body = {
    schema: "buildchain.build-checkpoint/v1",
    identity: buildRecoveryIdentity(plan, platform),
    source: plan.source,
    producer: plan.run,
    runtime: plan.runtime,
    platform: platform.id,
    manifestPath,
    files: retainedFiles.map((relative) => ({
      path: relative,
      mode: fs.statSync(path.join(sourceRoot, relative)).mode & 0o777,
      sha256: digestFile(path.join(sourceRoot, relative)),
    })),
  };
  const checkpoint = { ...body, root: rootOf(body) };
  const checkpointPath = `.buildchain/recovery/${platform.id}/checkpoint.json`;
  writeJson(path.join(sourceRoot, checkpointPath), checkpoint);
  return { checkpoint, paths: [checkpointPath, ...retainedFiles] };
}

export function restoreBuildCheckpoint({
  plan,
  platform,
  sourceRoot,
  retainedRoot,
}) {
  const checkpoint = readJson(
    path.join(
      retainedRoot,
      `.buildchain/recovery/${platform.id}/checkpoint.json`,
    ),
  );
  const { root, ...body } = checkpoint;
  if (
    checkpoint.schema !== "buildchain.build-checkpoint/v1" ||
    rootOf(body) !== root ||
    checkpoint.identity !== buildRecoveryIdentity(plan, platform) ||
    checkpoint.platform !== platform.id ||
    checkpoint.producer.repository !== plan.run.repository ||
    checkpoint.producer.id !== plan.recovery.runId
  )
    throw new Error(
      "Build checkpoint does not match the retained source, inputs or producer",
    );
  const expectedManifest = `.buildchain/artifacts/${platform.id}/manifest-build.json`;
  if (checkpoint.manifestPath !== expectedManifest)
    throw new Error("Unexpected build checkpoint manifest");
  const manifest = verifyManifest(
    path.join(retainedRoot, expectedManifest),
    retainedRoot,
    plan,
    platform,
  );
  if (!manifest.files.length)
    throw new Error("Build checkpoint has no retained outputs");
  const files = [
    ...manifest.files.map(({ path }) => path),
    expectedManifest,
    ...supportFiles(plan),
  ];
  if (
    !Array.isArray(checkpoint.files) ||
    JSON.stringify(checkpoint.files.map((f) => f.path)) !==
      JSON.stringify(files) ||
    checkpoint.files.some(
      (f) => !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o777,
    )
  )
    throw new Error("Build checkpoint file metadata is invalid");
  for (const file of checkpoint.files)
    if (file.sha256 !== digestFile(path.join(retainedRoot, file.path)))
      throw new Error("Build checkpoint retained file digest mismatch");
  // Validate every destination before changing the fresh source checkout.
  for (const relative of files) {
    if (relative.split("/").some((p) => [".git", ".github"].includes(p)))
      throw new Error(
        "Build checkpoint cannot replace repository control files",
      );
    const destination = path.resolve(sourceRoot, relative);
    if (!destination.startsWith(path.resolve(sourceRoot) + path.sep))
      throw new Error("Build checkpoint destination escapes source");
    let current = destination;
    while (current !== path.resolve(sourceRoot)) {
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (stat?.isSymbolicLink())
        throw new Error("Build checkpoint destination traverses a symlink");
      current = path.dirname(current);
    }
  }
  for (const relative of files) {
    const destination = path.resolve(sourceRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(retainedRoot, relative), destination);
    fs.chmodSync(
      destination,
      checkpoint.files.find((f) => f.path === relative).mode,
    );
  }
  return {
    checkpointRoot: root,
    producer: checkpoint.producer,
    stage: "build",
  };
}
