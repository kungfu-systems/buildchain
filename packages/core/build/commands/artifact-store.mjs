import fs from "node:fs";
import path from "node:path";
import artifact from "@actions/artifact";
import { create as createGlob } from "@actions/glob";
import { readJson, rootOf, writeJson } from "./context.mjs";

function findOptions(repository, runId, token) {
  const [repositoryOwner, repositoryName] = repository.split("/");
  return { findBy: { repositoryOwner, repositoryName, workflowRunId: Number(runId), token } };
}
export async function upload(plan, name, patterns, root, { allowEmpty = false } = {}) {
  const glob = await createGlob(patterns.map((p) => path.resolve(root, p)).join("\n"), { followSymbolicLinks: false, implicitDescendants: true, excludeHiddenFiles: false });
  const files = (await glob.glob()).filter((file) => fs.lstatSync(file).isFile());
  if (!files.length) {
    if (allowEmpty) return null;
    throw new Error(`No files for artifact ${name}`);
  }
  const realRoot = fs.realpathSync(root);
  for (const file of files) {
    if (!fs.realpathSync(file).startsWith(`${realRoot}${path.sep}`)) throw new Error("Upload path escapes artifact root");
  }
  const uploaded = await artifact.uploadArtifact(name, files, root, { retentionDays: plan.build.artifacts.retention_days, compressionLevel: plan.build.artifacts.compression_level });
  if (!uploaded.id || !uploaded.digest) throw new Error("Artifact provider omitted immutable coordinates");
  const ref = { schema: "buildchain.build-artifact/v1", repository: plan.run.repository, run_id: plan.run.id,
    plan_root: plan.root, source_sha: plan.source.sha, name, id: uploaded.id, digest: uploaded.digest };
  return { ...ref, root: rootOf(ref) };
}
export function validateReference(ref, plan, name) {
  const { root, ...body } = ref;
  if (ref.schema !== "buildchain.build-artifact/v1" || root !== rootOf(body) ||
      ref.repository !== plan.run.repository || ref.run_id !== plan.run.id || ref.plan_root !== plan.root ||
      ref.source_sha !== plan.source.sha || (name && ref.name !== name) || !Number.isSafeInteger(ref.id) || ref.id <= 0 ||
      !/^(?:sha256:)?[a-f0-9]{64}$/u.test(ref.digest)) throw new Error("Invalid producer artifact reference");
  return ref;
}
export async function download(ref, target, { token = process.env.GITHUB_TOKEN, repository = ref.repository, runId = ref.run_id } = {}) {
  const result = await artifact.downloadArtifact(ref.id, { path: target, expectedHash: ref.digest.replace(/^sha256:/u, ""), ...findOptions(repository, runId, token) });
  if (result.digestMismatch) throw new Error(`Provider archive digest mismatch: ${ref.name}`);
  return target;
}
export async function lookup(plan, name, { repository = plan.run.repository, runId = plan.run.id, token = process.env.GITHUB_TOKEN } = {}) {
  const { artifacts } = await artifact.listArtifacts({ ...findOptions(repository, runId, token) });
  const matches = artifacts.filter((item) => item.name === name);
  if (matches.length !== 1) throw new Error(`Expected one same-run artifact ${name}; found ${matches.length}`);
  const found = matches[0];
  if (!found.digest) throw new Error(`Artifact provider omitted digest: ${name}`);
  return { ...found, repository, run_id: String(runId) };
}
export async function downloadNamed(plan, name, target, options = {}) {
  const ref = await lookup(plan, name, options);
  await download(ref, target, options);
  return ref;
}
export async function publishRecord(plan, name, value, directory) {
  writeJson(path.join(directory, "record.json"), value);
  return upload(plan, name, ["record.json"], directory);
}
export async function readRecord(plan, name, directory) {
  await downloadNamed(plan, name, directory);
  return readJson(path.join(directory, "record.json"));
}
