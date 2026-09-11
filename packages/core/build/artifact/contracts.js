import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { rootOf, readJson } from "../plan/values.js";

export function artifactNames(plan, platform) {
  const base = plan.artifacts.name;
  const sha = plan.source.sha;
  const lane = `${platform.id}-${sha}`;
  const attempt = `${plan.run.id}-${plan.run.attempt}`;
  return {
    payload: `${base}-${lane}`,
    final: `${base}-final-${lane}`,
    manifest: `${base}-manifest-${lane}`,
    diagnostics: `${base}-diagnostics-${lane}`,
    execution: `${base}-execution-${lane}`,
    signing: `${base}-signing-${lane}`,
    request: `${base}-signing-request-${lane}-${attempt}`,
    control: `${base}-signing-control-request-${lane}-${attempt}`,
    result: `${base}-signing-result-${lane}-${attempt}`,
    attestation: `${base}-attestation-${lane}`,
    relay: `${base}-relay-manifest-${lane}`,
    credentialRelay: `${base}-credential-relay-manifest-${lane}`,
    credentialInput: `${base}-credential-input-${lane}`,
  };
}
export function executionResult(plan, platform, stages, artifacts = []) {
  const result = {
    schema: "buildchain.build-execution/v1",
    plan_root: plan.root,
    source_sha: plan.source.sha,
    runtime_sha: plan.identity.sha,
    platform: platform.id,
    run: plan.run,
    stages,
    artifacts,
  };
  return { ...result, root: rootOf(result) };
}
export function verifyExecutionIdentity(result, plan, platform) {
  const { root, ...body } = result;
  if (
    result.schema !== "buildchain.build-execution/v1" ||
    root !== rootOf(body) ||
    result.plan_root !== plan.root ||
    result.source_sha !== plan.source.sha ||
    result.platform !== platform.id ||
    JSON.stringify(result.run) !== JSON.stringify(plan.run)
  )
    throw new Error("Execution identity mismatch");
  if (!result.stages || !Array.isArray(result.artifacts))
    throw new Error("Execution evidence is incomplete");
  return result;
}
export function verifyExecution(result, plan, platform) {
  verifyExecutionIdentity(result, plan, platform);
  for (const stage of ["install", "build", "verify"]) {
    const state = result.stages[stage];
    if (
      state !== "success" &&
      !(state === "not-required" && !plan.lifecycle[stage].required)
    )
      throw new Error(`Nonqualifying ${platform.id} ${stage}: ${state}`);
  }
  return result;
}
export function verifyManifest(file, root, plan, platform) {
  const manifest = readJson(file);
  if (
    manifest.contract !== "kungfu-buildchain-artifact" ||
    manifest.platform?.id !== platform.id ||
    manifest.git?.sha !== plan.source.sha ||
    manifest.git?.treeSha !== plan.source.tree_sha ||
    manifest.git?.repository !== plan.run.repository
  ) {
    throw new Error(`Artifact manifest identity mismatch: ${platform.id}`);
  }
  verifyFiles(manifest, root);
  return manifest;
}
export function verifyFiles(manifest, root) {
  if (!Array.isArray(manifest.files))
    throw new Error("Missing artifact file manifest");
  for (const entry of manifest.files) {
    const relative = entry.path;
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").includes("..")
    )
      throw new Error("Unsafe artifact path");
    const target = path.resolve(root, relative);
    const real = fs.realpathSync(target);
    if (
      !real.startsWith(`${fs.realpathSync(root)}${path.sep}`) ||
      !fs.statSync(real).isFile()
    )
      throw new Error("Artifact escapes payload root");
    const bytes = fs.readFileSync(real);
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    const expected = String(entry.sha256 || entry.digest || "").replace(
      /^sha256:/u,
      "",
    );
    if (
      !expected ||
      actual !== expected ||
      ((entry.size ?? entry.bytes) !== undefined &&
        (entry.size ?? entry.bytes) !== bytes.length)
    )
      throw new Error(`Artifact digest mismatch: ${relative}`);
  }
  if (manifest.expectedArtifacts?.ok === false)
    throw new Error("Artifact expectations failed");
  return manifest;
}

export function verifyCredential(manifestFile, payloadRoot, plan, platform) {
  const manifest = readJson(manifestFile);
  if (
    manifest.contract !== "kungfu-buildchain-artifact" ||
    manifest.platform?.id !== `${platform.id}-credential` ||
    manifest.git?.repository !== plan.run.repository ||
    manifest.git?.sha !== plan.source.sha ||
    String(manifest.git?.runId) !== plan.run.id ||
    String(manifest.git?.runAttempt) !== plan.run.attempt
  )
    throw new Error("Credential artifact identity mismatch");
  verifyFiles(manifest, payloadRoot);
  const evidence = manifest.files
    .filter((entry) => entry.path.endsWith(".json"))
    .map((entry) => readJson(path.join(payloadRoot, entry.path)))
    .filter(
      (entry) =>
        entry.schema === "buildchain.macos-credential-island-evidence/v1",
    );
  if (
    evidence.length !== 1 ||
    evidence[0].status !== "accepted" ||
    evidence[0].source?.repository !== plan.run.repository ||
    evidence[0].source?.sha !== plan.source.sha ||
    evidence[0].source?.treeSha !== plan.source.tree_sha
  )
    throw new Error("Credential evidence identity mismatch");
  return manifest;
}

export function validateReference(ref, plan, name) {
  const { root, ...body } = ref;
  if (
    ref.schema !== "buildchain.build-artifact/v1" ||
    root !== rootOf(body) ||
    ref.repository !== plan.run.repository ||
    ref.run_id !== plan.run.id ||
    ref.plan_root !== plan.root ||
    ref.source_sha !== plan.source.sha ||
    (name && ref.name !== name) ||
    !Number.isSafeInteger(ref.id) ||
    ref.id <= 0 ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(ref.digest)
  )
    throw new Error("Invalid producer artifact reference");
  return ref;
}
