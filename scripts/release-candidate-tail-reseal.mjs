#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertArtifactSigningControlRequestContext,
  readArtifactSigningControlRequest,
  settleArtifactSigningControl,
  validateArtifactSigningControllerReceipt,
} from "./artifact-signing-controller.mjs";

const CONTRACT = "kungfu-buildchain-release-candidate-tail-reseal/v1";
const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const REQUIRED_PLATFORMS = ["linux-arm64", "linux-x64", "macos-arm64", "windows-x64"];
const PLATFORM_BUILD_JOBS = [
  "build / Linux ARM64",
  "build / Linux x64",
  "build / macOS ARM64",
  "build / Windows x64",
];
const SIGNING_CONTROL_JOBS = [
  "build / Control detached signing Linux ARM64",
  "build / Control detached signing Linux x64",
  "build / Control detached signing macOS ARM64",
  "build / Control detached signing Windows x64",
];
const FINALIZED_PLATFORM_JOBS = [
  "build / Finalize signed artifact Linux ARM64",
  "build / Finalize signed artifact Linux x64",
  "build / Finalize signed artifact macOS ARM64",
  "build / Finalize signed artifact Windows x64",
];
const CANDIDATE_TAIL_JOBS = [
  "build / Summarize build contract",
  "build / Finalize build controller evidence",
  "Precompute non-secret Alpha publication tail",
];
const FAILURE_MODES = {
  finalization: "macos-finalization",
  signingControl: "macos-signing-control",
  productUpgradePublicationAdmission: "product-upgrade-publication-admission",
};

function required(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function exactSha(value, label) {
  const result = required(value, label);
  if (!SHA.test(result)) throw new Error(`${label} must be an exact lowercase Git SHA`);
  return result;
}

function contentRoot(value, label) {
  const result = required(value, label);
  if (!ROOT.test(result)) throw new Error(`${label} must be a sha256 content root`);
  return result;
}

function integer(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`);
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function tailResealFailureMode(request) {
  const failure = object(request?.failure, "failure");
  if (
    failure.jobName === "build / Finalize signed artifact macOS ARM64" &&
    failure.stepName === "Recompute manifest over final signed bytes"
  ) return FAILURE_MODES.finalization;
  if (
    failure.jobName === "build / Control detached signing macOS ARM64" &&
    failure.stepName === "Enforce qualifying detached signing settlement"
  ) return FAILURE_MODES.signingControl;
  if (
    failure.jobName === "Finalize product upgrade publication admission" &&
    failure.stepName === "Qualify exact product bytes and seal admission receipt"
  ) return FAILURE_MODES.productUpgradePublicationAdmission;
  throw new Error("tail reseal failure is outside the supported exact recovery boundaries");
}

function appendOutputs(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const lines = [];
  for (const [name, value] of Object.entries(values)) {
    const text = String(value ?? "");
    if (text.includes("\n")) {
      const marker = `BUILDCHAIN_${crypto.randomBytes(8).toString("hex")}`;
      lines.push(`${name}<<${marker}\n${text}\n${marker}`);
    } else {
      lines.push(`${name}=${text}`);
    }
  }
  fs.appendFileSync(output, `${lines.join("\n")}\n`);
}

async function githubJson(repository, apiPath, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}${apiPath}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required(token, "GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${apiPath} failed: HTTP ${response.status}`);
  return response.json();
}

async function pagedGithubItems(repository, apiPath, key, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const response = await githubJson(repository, `${apiPath}${separator}per_page=100&page=${page}`, token);
    const items = Array.isArray(response?.[key]) ? response[key] : [];
    values.push(...items);
    if (items.length < 100) return values;
  }
}

export function normalizeTailResealRequest(raw) {
  const request = object(raw, "tail reseal request");
  if (request.contract !== CONTRACT) throw new Error(`tail reseal contract must be ${CONTRACT}`);
  const source = object(request.source, "source");
  const target = object(request.target, "target");
  const candidateRuntime = object(request.candidateRuntime, "candidateRuntime");
  const controller = object(request.consumerController, "consumerController");
  const failure = object(request.failure, "failure");
  const authority = object(request.authority, "authority");
  const platforms = Array.isArray(request.platforms) ? request.platforms : [];
  if (platforms.length !== REQUIRED_PLATFORMS.length) throw new Error("tail reseal requires exactly four platform bindings");
  const normalizedPlatforms = platforms.map((entry, index) => {
    const platform = object(entry, `platforms[${index}]`);
    return {
      id: required(platform.id, `platforms[${index}].id`),
      name: required(platform.name, `platforms[${index}].name`),
      runner: required(platform.runner, `platforms[${index}].runner`),
      artifactName: required(platform.artifactName, `platforms[${index}].artifactName`),
      artifactDigest: contentRoot(platform.artifactDigest, `platforms[${index}].artifactDigest`),
      manifestArtifactName: required(platform.manifestArtifactName, `platforms[${index}].manifestArtifactName`),
      manifestArtifactDigest: contentRoot(platform.manifestArtifactDigest, `platforms[${index}].manifestArtifactDigest`),
      artifactPaths: required(platform.artifactPaths, `platforms[${index}].artifactPaths`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(normalizedPlatforms.map(({ id }) => id)) !== JSON.stringify([...REQUIRED_PLATFORMS].sort())) {
    throw new Error(`tail reseal platforms must be ${REQUIRED_PLATFORMS.join(", ")}`);
  }
  if (new Set(normalizedPlatforms.flatMap((entry) => [entry.artifactName, entry.manifestArtifactName])).size !== 8) {
    throw new Error("tail reseal artifact names must be unique");
  }
  return {
    contract: CONTRACT,
    repository: required(request.repository, "repository"),
    source: {
      runId: integer(source.runId, "source.runId"),
      runAttempt: integer(source.runAttempt, "source.runAttempt"),
      sha: exactSha(source.sha, "source.sha"),
      headSha: exactSha(source.headSha || source.sha, "source.headSha"),
      tree: exactSha(source.tree, "source.tree"),
      workflowFile: required(source.workflowFile, "source.workflowFile").replace(/^\.github\/workflows\//u, ""),
      workflowName: required(source.workflowName, "source.workflowName"),
    },
    target: {
      channel: required(target.channel, "target.channel"),
      ref: required(target.ref, "target.ref").replace(/^refs\/heads\//u, ""),
      baseSha: exactSha(target.baseSha, "target.baseSha"),
      version: required(target.version, "target.version"),
    },
    candidateRuntime: {
      repository: required(candidateRuntime.repository, "candidateRuntime.repository"),
      ref: required(candidateRuntime.ref, "candidateRuntime.ref"),
      sha: exactSha(candidateRuntime.sha, "candidateRuntime.sha"),
      contractDigest: contentRoot(candidateRuntime.contractDigest, "candidateRuntime.contractDigest"),
    },
    consumerController: {
      repository: required(controller.repository, "consumerController.repository"),
      sha: exactSha(controller.sha, "consumerController.sha"),
      tree: exactSha(controller.tree, "consumerController.tree"),
    },
    failure: {
      jobId: integer(failure.jobId, "failure.jobId"),
      jobName: required(failure.jobName, "failure.jobName"),
      stepName: required(failure.stepName, "failure.stepName"),
    },
    authority: {
      repository: required(authority.repository, "authority.repository"),
      runId: integer(authority.runId, "authority.runId"),
      runtimeSha: exactSha(authority.runtimeSha, "authority.runtimeSha"),
      resultArtifact: required(authority.resultArtifact, "authority.resultArtifact"),
      resultArtifactDigest: contentRoot(authority.resultArtifactDigest, "authority.resultArtifactDigest"),
    },
    controllerPlanArtifact: required(request.controllerPlanArtifact, "controllerPlanArtifact"),
    platforms: normalizedPlatforms,
  };
}

function exactArtifact(artifacts, name, digest, label) {
  const matches = artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1) throw new Error(`${label} must resolve to exactly one retained artifact`);
  const artifact = matches[0];
  if (artifact.expired === true) throw new Error(`${label} is expired`);
  if (artifact.digest !== digest) throw new Error(`${label} digest mismatch`);
  return artifact;
}

function validateTailResealEvent({ request, event, repository }) {
  const allowedActions = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
  if (request.repository !== repository) throw new Error("tail reseal repository differs from the caller repository");
  if (!allowedActions.has(event.action)) {
    throw new Error(`tail reseal requires a pull_request source event, got ${event.action || "<none>"}`);
  }
  if (event.pull_request?.head?.repo?.full_name !== repository) throw new Error("tail reseal rejects fork pull requests");
  if (event.pull_request?.head?.sha !== request.source.headSha) throw new Error("tail reseal source head SHA differs from the exact PR head");
  if (event.pull_request?.base?.ref !== request.target.ref || event.pull_request?.base?.sha !== request.target.baseSha) {
    throw new Error("tail reseal target ref or frozen base SHA differs from the exact PR event");
  }
  if (request.target.channel !== "alpha" || !/^alpha\/v\d+\/v\d+\.\d+$/u.test(request.target.ref)) {
    throw new Error("tail reseal is limited to an exact Alpha channel");
  }
  if (request.candidateRuntime.repository !== "kungfu-systems/buildchain" || request.candidateRuntime.ref !== "v3-alpha") {
    throw new Error("tail reseal requires the deployed floating v3-alpha candidate contract");
  }
  if (request.consumerController.repository !== repository) throw new Error("tail reseal consumer controller must remain in the caller repository");
}

export function validateTailResealRun({ request, run }) {
  const workflowFile = String(run.path || "").split("@")[0].replace(/^\.github\/workflows\//u, "");
  const failureMode = tailResealFailureMode(request);
  const expectedEvent = failureMode === FAILURE_MODES.productUpgradePublicationAdmission
    ? "pull_request"
    : "workflow_dispatch";
  const exactRun =
    Number(run.id) === request.source.runId &&
    Number(run.run_attempt) === request.source.runAttempt &&
    run.event === expectedEvent &&
    run.status === "completed" &&
    run.conclusion === "failure" &&
    run.head_sha === request.source.headSha &&
    workflowFile === request.source.workflowFile &&
    run.name === request.source.workflowName;
  if (!exactRun) throw new Error("tail reseal source run is not the exact retained failed Build run");
}

export function validateTailResealJobs({ request, jobs }) {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const failureMode = tailResealFailureMode(request);
  const requiredSuccessJobs = failureMode === FAILURE_MODES.finalization
    ? [...PLATFORM_BUILD_JOBS, ...SIGNING_CONTROL_JOBS, ...FINALIZED_PLATFORM_JOBS.filter((name) => !name.endsWith("macOS ARM64"))]
    : failureMode === FAILURE_MODES.signingControl
      ? [...PLATFORM_BUILD_JOBS, ...SIGNING_CONTROL_JOBS.filter((name) => !name.endsWith("macOS ARM64"))]
      : [...PLATFORM_BUILD_JOBS, ...SIGNING_CONTROL_JOBS, ...FINALIZED_PLATFORM_JOBS, ...CANDIDATE_TAIL_JOBS];
  for (const name of requiredSuccessJobs) {
    if (byName.get(name)?.conclusion !== "success") throw new Error(`tail reseal required source job did not succeed: ${name}`);
  }
  const failedJob = jobs.find((job) => Number(job.id) === request.failure.jobId);
  const failedSteps = (failedJob?.steps || []).filter((step) => step.conclusion === "failure").map((step) => step.name);
  const exactFailure =
    failedJob?.name === request.failure.jobName &&
    failedJob?.conclusion === "failure" &&
    JSON.stringify(failedSteps) === JSON.stringify([request.failure.stepName]);
  if (!exactFailure) throw new Error("tail reseal failure boundary differs from the selected exact recovery step");
  if (failureMode === FAILURE_MODES.signingControl) {
    const controller = byName.get("build / Finalize build controller evidence");
    const controllerFailures = (controller?.steps || []).filter((step) => step.conclusion === "failure").map((step) => step.name);
    if (
      controller?.conclusion !== "failure" ||
      JSON.stringify(controllerFailures) !== JSON.stringify(["Enforce qualifying build controller receipt"])
    ) throw new Error("tail reseal signing-control recovery requires the exact downstream controller failure");
  }
  return failureMode;
}

function validateTailResealArtifacts({ request, artifacts, authorityRun, authorityArtifacts }) {
  for (const platform of request.platforms) {
    exactArtifact(artifacts, platform.artifactName, platform.artifactDigest, `${platform.id} payload`);
    exactArtifact(artifacts, platform.manifestArtifactName, platform.manifestArtifactDigest, `${platform.id} manifest`);
  }
  const controllerPlan = artifacts.filter((artifact) => artifact.name === request.controllerPlanArtifact);
  if (controllerPlan.length !== 1 || controllerPlan[0].expired === true) throw new Error("tail reseal controller plan artifact is unavailable");
  if (authorityRun.status !== "completed" || authorityRun.conclusion !== "success") throw new Error("tail reseal signing authority run is not successful");
  if (authorityRun.head_sha !== request.authority.runtimeSha || authorityRun.event !== "workflow_dispatch") {
    throw new Error("tail reseal signing authority run identity mismatch");
  }
  exactArtifact(authorityArtifacts, request.authority.resultArtifact, request.authority.resultArtifactDigest, "macOS signing authority result");
}

function writeTailResealPlan(request) {
  const output = path.resolve(process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH || ".buildchain/tail-reseal/request.json");
  writeJson(output, request);
  appendOutputs({
    enabled: "true",
    "request-path": path.relative(process.cwd(), output),
    "request-root": sha256Json(request),
    "platforms-json": JSON.stringify(request.platforms),
    "source-run-id": request.source.runId,
    "source-run-attempt": request.source.runAttempt,
    "source-sha": request.source.sha,
    "source-tree": request.source.tree,
    "target-channel": request.target.channel,
    "target-ref": request.target.ref,
    "target-version": request.target.version,
    "candidate-runtime-ref": request.candidateRuntime.ref,
    "candidate-runtime-sha": request.candidateRuntime.sha,
    "candidate-runtime-contract-digest": request.candidateRuntime.contractDigest,
    "consumer-controller-sha": request.consumerController.sha,
    "authority-run-id": request.authority.runId,
    "authority-result-artifact": request.authority.resultArtifact,
    "controller-plan-artifact": request.controllerPlanArtifact,
    "failure-mode": tailResealFailureMode(request),
  });
}

async function plan() {
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const raw = required(process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_JSON, "BUILDCHAIN_TAIL_RESEAL_REQUEST_JSON");
  const request = normalizeTailResealRequest(JSON.parse(raw));
  const event = readJson(required(process.env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH"), "GitHub event");
  const repository = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  validateTailResealEvent({ request, event, repository });

  const [sourceCommit, sourceHeadCommit, controllerCommit, run, jobs, artifacts, authorityRun, authorityArtifacts] = await Promise.all([
    githubJson(repository, `/git/commits/${request.source.sha}`, token),
    githubJson(repository, `/git/commits/${request.source.headSha}`, token),
    githubJson(repository, `/git/commits/${request.consumerController.sha}`, token),
    githubJson(repository, `/actions/runs/${request.source.runId}`, token),
    pagedGithubItems(repository, `/actions/runs/${request.source.runId}/jobs?filter=latest`, "jobs", token),
    pagedGithubItems(repository, `/actions/runs/${request.source.runId}/artifacts`, "artifacts", token),
    githubJson(request.authority.repository, `/actions/runs/${request.authority.runId}`, token),
    pagedGithubItems(request.authority.repository, `/actions/runs/${request.authority.runId}/artifacts`, "artifacts", token),
  ]);
  if (sourceCommit.tree?.sha !== request.source.tree) throw new Error("tail reseal source tree mismatch");
  if (sourceHeadCommit.tree?.sha !== request.source.tree) throw new Error("tail reseal source head is not tree-equivalent to retained artifacts");
  if (controllerCommit.tree?.sha !== request.consumerController.tree) throw new Error("tail reseal consumer controller tree mismatch");
  validateTailResealRun({ request, run });
  validateTailResealJobs({ request, jobs });
  validateTailResealArtifacts({ request, artifacts, authorityRun, authorityArtifacts });
  writeTailResealPlan(request);
  return request;
}

function locateManifest(root, platformId) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === "manifest.json") {
        const value = readJson(absolute);
        if (value?.contract === "kungfu-buildchain-artifact" && value?.platform?.id === platformId) matches.push({ absolute, value });
      }
    }
  };
  visit(root);
  if (matches.length !== 1) throw new Error(`expected exactly one ${platformId} platform manifest under ${root}, found ${matches.length}`);
  return matches[0];
}

function assertMacosTailManifest({ request, platform, manifest, label }) {
  if (manifest.contract !== "kungfu-buildchain-artifact") throw new Error(`${label} macos-arm64 manifest contract mismatch`);
  if (manifest.artifactName !== platform.artifactName) throw new Error(`${label} macos-arm64 manifest artifact name mismatch`);
  if (manifest.platform?.id !== "macos-arm64") throw new Error(`${label} macos-arm64 manifest platform mismatch`);
  if (manifest.git?.repository !== request.repository || manifest.git?.sha !== request.source.sha) {
    throw new Error(`${label} macos-arm64 manifest source mismatch`);
  }
}

export function prepareTailResealMacosManifestRecompute() {
  const request = normalizeTailResealRequest(readJson(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH",
  )));
  const platformId = required(
    process.env.BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID,
    "BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID",
  );
  if (platformId !== "macos-arm64") {
    throw new Error("tail reseal manifest recompute preparation is only valid for macos-arm64");
  }
  const platform = request.platforms.find((entry) => entry.id === platformId);
  if (!platform) throw new Error(`tail reseal request does not bind platform ${platformId}`);

  const manifestPath = path.resolve(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH",
  ));
  const preservedManifestPath = path.resolve(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH",
  ));
  const manifestDirectory = path.dirname(manifestPath);
  if (preservedManifestPath === manifestPath || preservedManifestPath.startsWith(`${manifestDirectory}${path.sep}`)) {
    throw new Error("pre-signing macos-arm64 manifest must be preserved outside the recomputed artifact directory");
  }
  const manifest = object(readJson(manifestPath, "pre-signing platform manifest"), "pre-signing platform manifest");
  assertMacosTailManifest({ request, platform, manifest, label: "pre-signing" });
  if (
    String(manifest.git?.runId || "") !== String(request.source.runId) ||
    String(manifest.git?.runAttempt || "") !== String(request.source.runAttempt)
  ) throw new Error("pre-signing macos-arm64 manifest original run mismatch");

  fs.mkdirSync(path.dirname(preservedManifestPath), { recursive: true });
  fs.copyFileSync(manifestPath, preservedManifestPath);
  for (const generated of ["manifest.json", "summary.json", "diagnostics.json"]) {
    const generatedPath = path.join(manifestDirectory, generated);
    if (fs.existsSync(generatedPath)) fs.rmSync(generatedPath);
  }
  appendOutputs({
    "pre-signing-manifest-path": path.relative(process.cwd(), preservedManifestPath),
  });
  return manifest;
}

export function restoreTailResealManifestRunIdentity() {
  const request = normalizeTailResealRequest(readJson(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH",
  )));
  const platformId = required(
    process.env.BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID,
    "BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID",
  );
  if (platformId !== "macos-arm64") {
    throw new Error("tail reseal manifest run identity restoration is only valid for macos-arm64");
  }
  const platform = request.platforms.find((entry) => entry.id === platformId);
  if (!platform) throw new Error(`tail reseal request does not bind platform ${platformId}`);

  const manifestPath = path.resolve(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH",
  ));
  const preSigningManifestPath = path.resolve(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH",
  ));
  const manifest = object(readJson(manifestPath, "recomputed platform manifest"), "recomputed platform manifest");
  const preSigning = object(readJson(preSigningManifestPath, "pre-signing platform manifest"), "pre-signing platform manifest");

  assertMacosTailManifest({ request, platform, manifest, label: "recomputed" });
  assertMacosTailManifest({ request, platform, manifest: preSigning, label: "pre-signing" });
  if (
    String(preSigning.git?.runId || "") !== String(request.source.runId) ||
    String(preSigning.git?.runAttempt || "") !== String(request.source.runAttempt)
  ) throw new Error("pre-signing macos-arm64 manifest original run mismatch");

  const currentRunId = required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const currentRunAttempt = required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  const recomputedRun = `${String(manifest.git?.runId || "")}:${String(manifest.git?.runAttempt || "")}`;
  const originalRun = `${request.source.runId}:${request.source.runAttempt}`;
  const currentRun = `${currentRunId}:${currentRunAttempt}`;
  if (recomputedRun !== originalRun && recomputedRun !== currentRun) {
    throw new Error("recomputed macos-arm64 manifest run is neither the original build nor the current tail run");
  }

  manifest.git.runId = String(request.source.runId);
  manifest.git.runAttempt = String(request.source.runAttempt);
  writeJson(manifestPath, manifest);
  const archivedPreSigningManifestPath = String(
    process.env.BUILDCHAIN_TAIL_RESEAL_ARCHIVED_PRE_SIGNING_MANIFEST_PATH || "",
  ).trim();
  if (archivedPreSigningManifestPath) {
    const archivedPath = path.resolve(archivedPreSigningManifestPath);
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.copyFileSync(preSigningManifestPath, archivedPath);
  }
  appendOutputs({
    "manifest-path": path.relative(process.cwd(), manifestPath),
    "restored-run-id": request.source.runId,
    "restored-run-attempt": request.source.runAttempt,
  });
  return manifest;
}

export function verifyTailResealPlatform() {
  const request = normalizeTailResealRequest(readJson(required(process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH, "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH")));
  const platformId = required(process.env.BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID, "BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID");
  const platform = request.platforms.find((entry) => entry.id === platformId);
  if (!platform) throw new Error(`tail reseal request does not bind platform ${platformId}`);
  const root = path.resolve(process.env.BUILDCHAIN_TAIL_RESEAL_ARTIFACT_ROOT || ".");
  const { absolute, value: manifest } = locateManifest(root, platformId);
  if (manifest.artifactName !== platform.artifactName) throw new Error(`${platformId} manifest artifact name mismatch`);
  if (manifest.git?.repository !== request.repository || manifest.git?.sha !== request.source.sha) throw new Error(`${platformId} manifest source mismatch`);
  if (String(manifest.git?.runId || "") !== String(request.source.runId) || String(manifest.git?.runAttempt || "") !== String(request.source.runAttempt)) {
    throw new Error(`${platformId} manifest original run mismatch`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) throw new Error(`${platformId} manifest has no files`);
  for (const file of files) {
    const relative = required(file.path || file.name, `${platformId} manifest file path`);
    const absoluteFile = path.resolve(root, relative);
    if (!absoluteFile.startsWith(`${root}${path.sep}`) || !fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
      throw new Error(`${platformId} manifest file is missing: ${relative}`);
    }
    if (Number(file.size ?? file.bytes) !== fs.statSync(absoluteFile).size) throw new Error(`${platformId} manifest file size mismatch: ${relative}`);
    const expected = contentRoot(`sha256:${String(file.sha256 || "").replace(/^sha256:/u, "")}`, `${platformId} ${relative} digest`);
    if (sha256File(absoluteFile) !== expected) throw new Error(`${platformId} manifest file digest mismatch: ${relative}`);
  }
  appendOutputs({ "manifest-path": path.relative(process.cwd(), absolute), "manifest-root": sha256File(absolute) });
  return manifest;
}

function verifiedManifestFile({ root, manifestFiles, relative, label }) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${label} is missing: ${relative}`);
  }
  const entry = manifestFiles.get(relative);
  if (!entry) throw new Error(`${label} is not bound by the retained macos-arm64 manifest: ${relative}`);
  if (Number(entry.size ?? entry.bytes) !== fs.statSync(absolute).size) throw new Error(`${label} size mismatch: ${relative}`);
  const expected = contentRoot(`sha256:${String(entry.sha256 || "").replace(/^sha256:/u, "")}`, `${label} digest`);
  if (sha256File(absolute) !== expected) throw new Error(`${label} digest mismatch: ${relative}`);
  return absolute;
}

export function verifyTailResealCredentialIslandProjection() {
  const request = normalizeTailResealRequest(readJson(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH",
  )));
  const root = path.resolve(process.env.BUILDCHAIN_TAIL_RESEAL_ARTIFACT_ROOT || ".");
  const manifestPath = path.resolve(required(
    process.env.BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH,
    "BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH",
  ));
  const platform = request.platforms.find((entry) => entry.id === "macos-arm64");
  if (!platform) throw new Error("tail reseal request does not bind platform macos-arm64");
  const manifest = object(readJson(manifestPath, "retained macos-arm64 manifest"), "retained macos-arm64 manifest");
  assertMacosTailManifest({ request, platform, manifest, label: "retained" });
  if (
    String(manifest.git?.runId || "") !== String(request.source.runId) ||
    String(manifest.git?.runAttempt || "") !== String(request.source.runAttempt)
  ) throw new Error("retained macos-arm64 manifest original run mismatch");
  const manifestFiles = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((entry) => [
    String(entry.path || entry.name || "").replaceAll("\\", "/"),
    entry,
  ]));
  const declaredCredentialRoot = String(process.env.BUILDCHAIN_TAIL_RESEAL_CREDENTIAL_ARTIFACT_ROOT || "").trim();
  const credentialManifestCandidates = [...manifestFiles.keys()].filter((relative) =>
    relative.endsWith("/credential-artifact/manifest.json") || relative === "credential-artifact/manifest.json"
  );
  if (!declaredCredentialRoot && credentialManifestCandidates.length !== 1) {
    throw new Error(`retained macos-arm64 manifest must bind exactly one credential-island projection; found ${credentialManifestCandidates.length}`);
  }
  const credentialRoot = declaredCredentialRoot
    ? path.resolve(declaredCredentialRoot)
    : path.resolve(root, path.dirname(credentialManifestCandidates[0]));
  if (
    !credentialRoot.startsWith(`${root}${path.sep}`) ||
    !fs.existsSync(credentialRoot) ||
    !fs.statSync(credentialRoot).isDirectory()
  ) {
    throw new Error("credential-island projection root is outside the retained macos-arm64 payload");
  }
  const credentialRelativeRoot = path.relative(root, credentialRoot).split(path.sep).join("/");
  const credentialManifestRelative = `${credentialRelativeRoot}/manifest.json`;
  const credentialManifestPath = verifiedManifestFile({
    root,
    manifestFiles,
    relative: credentialManifestRelative,
    label: "credential-island manifest",
  });
  const credentialManifest = object(
    readJson(credentialManifestPath, "credential-island manifest"),
    "credential-island manifest",
  );
  if (
    credentialManifest.schemaVersion !== 1 ||
    credentialManifest.contract !== "kungfu-buildchain-artifact" ||
    credentialManifest.platform?.id !== "macos-arm64-credential" ||
    credentialManifest.git?.repository !== request.repository ||
    credentialManifest.git?.sha !== request.source.sha ||
    credentialManifest.lifecycle?.stage !== "credential-island" ||
    credentialManifest.lifecycle?.executed !== true ||
    credentialManifest.expectedArtifacts?.ok !== true
  ) throw new Error("credential-island projection identity or lifecycle is not qualifying");
  const credentialFiles = Array.isArray(credentialManifest.files) ? credentialManifest.files : [];
  if (credentialFiles.length !== 3) {
    throw new Error(`credential-island projection must contain exactly three files, found ${credentialFiles.length}`);
  }
  for (const entry of credentialFiles) {
    const relative = required(entry.path || entry.name, "credential-island file path").replaceAll("\\", "/");
    if (relative.startsWith("/") || relative.split("/").includes("..")) {
      throw new Error(`credential-island file path is unsafe: ${relative}`);
    }
    const boundRelative = `${credentialRelativeRoot}/${relative}`;
    const absolute = verifiedManifestFile({
      root,
      manifestFiles,
      relative: boundRelative,
      label: "credential-island file",
    });
    if (
      Number(entry.size ?? entry.bytes) !== fs.statSync(absolute).size ||
      sha256File(absolute) !== `sha256:${String(entry.sha256 || "").replace(/^sha256:/u, "")}`
    ) throw new Error(`credential-island inner manifest mismatch: ${relative}`);
  }
  appendOutputs({
    "credential-artifact-root": path.relative(process.cwd(), credentialRoot),
    "credential-manifest-path": path.relative(process.cwd(), credentialManifestPath),
    "credential-manifest-root": sha256File(credentialManifestPath),
  });
  return credentialManifest;
}

export function recoverTailResealSigning() {
  const request = normalizeTailResealRequest(readJson(required(process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH, "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH")));
  if (tailResealFailureMode(request) !== FAILURE_MODES.signingControl) {
    throw new Error("signing settlement recovery is only valid for the exact macOS signing-control boundary");
  }
  if (request.authority.repository !== request.candidateRuntime.repository || request.authority.runtimeSha !== request.candidateRuntime.sha) {
    throw new Error("signing settlement recovery authority differs from the exact candidate runtime");
  }
  const control = assertArtifactSigningControlRequestContext(readArtifactSigningControlRequest(), {
    sourceRepository: request.repository,
    sourceRunId: String(request.source.runId),
    sourceRunAttempt: String(request.source.runAttempt),
    sourceSha: request.source.sha,
    sourceTreeSha: request.source.tree,
    runtimeRepository: request.candidateRuntime.repository,
    runtimeSha: request.candidateRuntime.sha,
    platformId: "macos-arm64",
  });
  const failedReceipt = validateArtifactSigningControllerReceipt(readJson(
    required(process.env.BUILDCHAIN_FAILED_SIGNING_CONTROLLER_RECEIPT_PATH, "BUILDCHAIN_FAILED_SIGNING_CONTROLLER_RECEIPT_PATH"),
    "failed signing controller receipt",
  ));
  if (
    failedReceipt.requestDigest !== control.digest ||
    failedReceipt.qualifying !== false ||
    failedReceipt.controller.status !== "failed" ||
    failedReceipt.source.sha !== request.source.sha ||
    failedReceipt.runtime.sha !== request.candidateRuntime.sha ||
    failedReceipt.platform.id !== "macos-arm64"
  ) throw new Error("original signing controller receipt is not the exact non-qualifying macOS settlement");
  if (
    control.authority.repository !== request.authority.repository ||
    control.authority.resultArtifact !== request.authority.resultArtifact
  ) throw new Error("successful authority result is not bound to the original signing control request");
  const settled = settleArtifactSigningControl({
    request: control,
    authorityStatus: "succeeded",
    authorityRunId: String(request.authority.runId),
    authorityRuntimeSha: request.authority.runtimeSha,
    authorityRunUrl: `https://github.com/${request.authority.repository}/actions/runs/${request.authority.runId}`,
    authorityResultArtifact: request.authority.resultArtifact,
    authorityCorrelationId: control.authority.correlationId,
    authorityConclusion: "success",
    controllerJob: "tail-reseal-signing-settlement",
  });
  if (!settled.receipt.qualifying || !settled.delegation) throw new Error("recovered signing settlement did not qualify");
  appendOutputs({
    "controller-receipt-digest": settled.receipt.digest,
    "delegation-created": "true",
  });
  return settled;
}

export function sealTailResealReceipt() {
  const request = normalizeTailResealRequest(readJson(required(process.env.BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH, "BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH")));
  const manifestsRoot = path.resolve(required(process.env.BUILDCHAIN_TAIL_RESEAL_MANIFESTS_ROOT, "BUILDCHAIN_TAIL_RESEAL_MANIFESTS_ROOT"));
  const manifests = request.platforms.map((platform) => {
    const { absolute, value } = locateManifest(manifestsRoot, platform.id);
    if (value.artifactName !== platform.artifactName || value.git?.sha !== request.source.sha) throw new Error(`${platform.id} resealed manifest identity mismatch`);
    return { platformId: platform.id, artifactName: platform.artifactName, manifestRoot: sha256File(absolute) };
  });
  const failureMode = tailResealFailureMode(request);
  const reusesFinalizedArtifacts = failureMode === FAILURE_MODES.productUpgradePublicationAdmission;
  const receipt = {
    contract: CONTRACT,
    action: "reused-tail-reseal",
    repository: request.repository,
    source: request.source,
    target: request.target,
    candidateRuntime: request.candidateRuntime,
    recoveryTooling: {
      ref: required(process.env.BUILDCHAIN_TAIL_RESEAL_TOOLING_REF, "BUILDCHAIN_TAIL_RESEAL_TOOLING_REF"),
      sha: exactSha(process.env.BUILDCHAIN_TAIL_RESEAL_TOOLING_SHA, "BUILDCHAIN_TAIL_RESEAL_TOOLING_SHA"),
    },
    consumerController: request.consumerController,
    originalFailure: request.failure,
    signingAuthority: request.authority,
    artifacts: request.platforms.map(({ id, artifactName, artifactDigest, manifestArtifactName, manifestArtifactDigest }) => ({
      platformId: id,
      artifactName,
      originalArtifactDigest: artifactDigest,
      manifestArtifactName,
      originalManifestArtifactDigest: manifestArtifactDigest,
    })),
    resealedManifests: manifests,
    skippedStages: ["install", "build", "verify", "platform-matrix"],
    rerunStages: reusesFinalizedArtifacts
      ? ["aggregate", "candidate-passport"]
      : ["macos-signing-finalization", "aggregate", "candidate-passport"],
    payloadPolicy: reusesFinalizedArtifacts
      ? "reuse-exact-platform-bytes"
      : "reuse-exact-platform-bytes-except-authoritative-macos-signing-import",
    currentRun: {
      id: required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      attempt: required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
    },
  };
  receipt.root = sha256Json(receipt);
  const output = path.resolve(process.env.BUILDCHAIN_TAIL_RESEAL_RECEIPT_PATH || ".buildchain/tail-reseal/receipt.json");
  writeJson(output, receipt);
  appendOutputs({ "receipt-path": path.relative(process.cwd(), output), "receipt-root": receipt.root, "receipt-json": JSON.stringify(receipt) });
  return receipt;
}

export async function releaseCandidateTailResealCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "plan") return plan();
  if (command === "recover-signing") return recoverTailResealSigning();
  if (command === "prepare-manifest-recompute") return prepareTailResealMacosManifestRecompute();
  if (command === "restore-manifest-run") return restoreTailResealManifestRunIdentity();
  if (command === "verify-platform") return verifyTailResealPlatform();
  if (command === "verify-credential-projection") return verifyTailResealCredentialIslandProjection();
  if (command === "seal") return sealTailResealReceipt();
  throw new Error("usage: release-candidate-tail-reseal.mjs <plan|recover-signing|prepare-manifest-recompute|restore-manifest-run|verify-platform|verify-credential-projection|seal>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  releaseCandidateTailResealCli().catch((error) => {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  });
}
