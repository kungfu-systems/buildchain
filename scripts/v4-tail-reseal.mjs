#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  V4_TAIL_RESEAL_PLATFORMS,
  normalizeV4TailResealRequest,
  planV4TailReseal,
} from "../packages/core/v4-tail-reseal.js";
import { createV4TailResealReceipt } from "../packages/core/v4-tail-reseal-receipt.js";
import { validateV4TailResealGitHubEvidence } from "../packages/core/v4-tail-reseal-github.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : String(args[index + 1] || "");
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

function writeJson(file, value) {
  const output = path.resolve(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
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

function appendOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n")}\n`,
  );
}

async function githubJson(repository, apiPath, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}${apiPath}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${required(token, "GITHUB_TOKEN")}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(`GitHub API ${apiPath} failed: HTTP ${response.status}`);
  return response.json();
}

async function pagedGithubItems(repository, apiPath, key, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const response = await githubJson(
      repository,
      `${apiPath}${separator}per_page=100&page=${page}`,
      token,
    );
    const items = Array.isArray(response?.[key]) ? response[key] : [];
    values.push(...items);
    if (items.length < 100) return values;
  }
}

async function admitFromGitHub(request) {
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const [
    sourceCommit,
    sourceRun,
    sourceJobs,
    sourceArtifacts,
    signingRun,
    signingArtifacts,
  ] = await Promise.all([
    githubJson(request.repository, `/git/commits/${request.source.sha}`, token),
    githubJson(
      request.repository,
      `/actions/runs/${request.source.runId}`,
      token,
    ),
    pagedGithubItems(
      request.repository,
      `/actions/runs/${request.source.runId}/jobs?filter=latest`,
      "jobs",
      token,
    ),
    pagedGithubItems(
      request.repository,
      `/actions/runs/${request.source.runId}/artifacts`,
      "artifacts",
      token,
    ),
    githubJson(
      request.signing.authorityRepository,
      `/actions/runs/${request.signing.authorityRunId}`,
      token,
    ),
    pagedGithubItems(
      request.signing.authorityRepository,
      `/actions/runs/${request.signing.authorityRunId}/artifacts`,
      "artifacts",
      token,
    ),
  ]);
  return validateV4TailResealGitHubEvidence({
    request,
    sourceCommit,
    sourceRun,
    sourceJobs,
    sourceArtifacts,
    signingRun,
    signingArtifacts,
  });
}

function locateManifest(root, platformId) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === "manifest.json") {
        const value = readJson(absolute);
        if (
          value?.contract === "kungfu-buildchain-artifact" &&
          value?.platform?.id === platformId
        )
          matches.push({ absolute, value });
      }
    }
  };
  visit(root);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${platformId} manifest under ${root}, found ${matches.length}`,
    );
  return matches[0];
}

function resolvePayload(root, relative, platformId) {
  const absolute = path.resolve(root, relative);
  if (
    !absolute.startsWith(`${root}${path.sep}`) ||
    !fs.existsSync(absolute) ||
    !fs.statSync(absolute).isFile()
  )
    throw new Error(`${platformId} manifest file is missing: ${relative}`);
  return absolute;
}

export function verifyV4TailResealPlatform({
  request,
  platformId,
  artifactRoot,
  mode = "retained",
  providerReadbackRoot = null,
} = {}) {
  const normalized = normalizeV4TailResealRequest(request);
  const platform = normalized.platforms.find(({ id }) => id === platformId);
  if (!platform)
    throw new Error(`tail reseal request does not bind platform ${platformId}`);
  if (!new Set(["retained", "resealed"]).has(mode))
    throw new Error(
      "tail reseal verification mode must be retained or resealed",
    );
  if (mode === "resealed" && platformId !== "macos-arm64")
    throw new Error("only macos-arm64 may produce a resealed byte set");
  const root = path.resolve(artifactRoot || ".");
  const { absolute: manifestPath, value: manifest } = locateManifest(
    root,
    platformId,
  );
  if (manifest.artifactName !== platform.artifactName)
    throw new Error(`${platformId} manifest artifact name mismatch`);
  if (
    manifest.git?.repository !== normalized.repository ||
    manifest.git?.sha !== normalized.source.sha ||
    manifest.git?.treeSha !== normalized.source.treeSha
  )
    throw new Error(`${platformId} manifest source mismatch`);
  if (
    Number(manifest.git?.runId) !== normalized.source.runId ||
    Number(manifest.git?.runAttempt) !== normalized.source.runAttempt
  )
    throw new Error(`${platformId} manifest original run mismatch`);
  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .map((file, index) => {
      const relative = required(
        file.path || file.name,
        `${platformId} manifest files[${index}] path`,
      );
      const absolute = resolvePayload(root, relative, platformId);
      const size = fs.statSync(absolute).size;
      if (Number(file.size ?? file.bytes) !== size)
        throw new Error(
          `${platformId} manifest file size mismatch: ${relative}`,
        );
      const digest = sha256File(absolute);
      const expected = `sha256:${String(file.sha256 || "").replace(/^sha256:/u, "")}`;
      if (digest !== expected)
        throw new Error(
          `${platformId} manifest file digest mismatch: ${relative}`,
        );
      return { path: relative, size, digest };
    })
    .sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
  if (files.length === 0)
    throw new Error(`${platformId} manifest has no retained files`);
  const observedArtifactRoot = v4ContentRoot(
    "tail-reseal-artifact-files",
    files,
  );
  const observedManifestRoot = sha256File(manifestPath);
  const retained = mode === "retained";
  if (
    retained &&
    (observedArtifactRoot !== platform.artifactRoot ||
      observedManifestRoot !== platform.manifestRoot)
  )
    throw new Error(
      `${platformId} retained artifact or manifest root mismatch`,
    );
  if (!retained) {
    if (
      observedArtifactRoot === platform.artifactRoot ||
      observedManifestRoot === platform.manifestRoot
    )
      throw new Error(
        "macos-arm64 reseal did not produce a distinct signed manifest",
      );
    if (providerReadbackRoot !== normalized.signing.providerReadbackRoot)
      throw new Error("macos-arm64 provider readback root mismatch");
  }
  return {
    platformId,
    artifactRoot: observedArtifactRoot,
    manifestRoot: observedManifestRoot,
    capsuleRoot: platform.capsuleRoot,
    byteIdentical: retained,
    providerReadbackRoot: retained ? null : providerReadbackRoot,
  };
}

function collectReadbacks(directory) {
  const byPlatform = new Map();
  for (const entry of fs.readdirSync(path.resolve(directory), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith("readback.json")) continue;
    const value = readJson(path.join(entry.parentPath, entry.name));
    if (byPlatform.has(value.platformId))
      throw new Error(`duplicate tail reseal readback for ${value.platformId}`);
    byPlatform.set(value.platformId, value);
  }
  return V4_TAIL_RESEAL_PLATFORMS.map((platformId) => {
    if (!byPlatform.has(platformId))
      throw new Error(`missing tail reseal readback for ${platformId}`);
    return byPlatform.get(platformId);
  });
}

export function runV4TailResealCli(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  const requestPath = flag(options, "request");
  if (command === "plan") {
    const request = normalizeV4TailResealRequest(
      readJson(required(requestPath, "--request"), "tail reseal request"),
    );
    const plan = planV4TailReseal(request);
    const output = writeJson(
      flag(options, "output", ".buildchain/tail-reseal/plan.json"),
      plan,
    );
    appendOutputs({
      "plan-root": plan.planRoot,
      "plan-path": path.relative(process.cwd(), output),
      "source-run-id": request.source.runId,
      "source-run-attempt": request.source.runAttempt,
      "source-sha": request.source.sha,
      "source-tree-sha": request.source.treeSha,
      "runtime-sha": request.runtime.sha,
      "consumer-policy-receipt-root": request.runtime.consumerPolicyReceiptRoot,
      "warrant-readback-root": request.warrant.stateReadbackRoot,
      "signing-provider-readback-root": request.signing.providerReadbackRoot,
      "release-tail-provider-readback-root":
        request.releaseTail.providerReadbackRoot,
      "signing-authority-repository": request.signing.authorityRepository,
      "signing-authority-run-id": request.signing.authorityRunId,
      "signing-result-artifact": request.signing.resultArtifact,
      "target-version": request.target.version,
      "platforms-json": JSON.stringify(request.platforms),
    });
    return plan;
  }
  if (command === "admit") {
    const request = normalizeV4TailResealRequest(
      readJson(required(requestPath, "--request"), "tail reseal request"),
    );
    return admitFromGitHub(request).then((admission) => {
      const output = writeJson(
        flag(options, "output", ".buildchain/tail-reseal/admission.json"),
        admission,
      );
      appendOutputs({
        "admission-root": admission.admissionRoot,
        "admission-path": path.relative(process.cwd(), output),
      });
      return admission;
    });
  }
  if (command === "verify-platform") {
    const readback = verifyV4TailResealPlatform({
      request: readJson(required(requestPath, "--request")),
      platformId: required(flag(options, "platform"), "--platform"),
      artifactRoot: flag(options, "artifact-root", process.cwd()),
      mode: flag(options, "mode", "retained"),
      providerReadbackRoot: flag(options, "provider-readback-root") || null,
    });
    const output = writeJson(
      flag(
        options,
        "output",
        `.buildchain/tail-reseal/${readback.platformId}-readback.json`,
      ),
      readback,
    );
    appendOutputs({
      "readback-path": path.relative(process.cwd(), output),
      "artifact-root": readback.artifactRoot,
      "manifest-root": readback.manifestRoot,
    });
    return readback;
  }
  if (command === "seal") {
    const request = readJson(required(requestPath, "--request"));
    const receipt = createV4TailResealReceipt({
      request,
      plan: readJson(required(flag(options, "plan"), "--plan")),
      readbacks: collectReadbacks(
        required(flag(options, "readbacks"), "--readbacks"),
      ),
      passport: readJson(required(flag(options, "passport"), "--passport")),
      protectedReadbackRoot: required(
        flag(options, "protected-readback-root"),
        "--protected-readback-root",
      ),
      currentRun: {
        id: Number(required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")),
        attempt: Number(
          required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        ),
      },
    });
    const output = writeJson(
      flag(options, "output", ".buildchain/tail-reseal/receipt.json"),
      receipt,
    );
    appendOutputs({
      "receipt-root": receipt.receiptRoot,
      "receipt-path": path.relative(process.cwd(), output),
    });
    return receipt;
  }
  throw new Error(
    "usage: buildchain tail-reseal <plan|admit|verify-platform|seal> --request <request.json> [options]",
  );
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runV4TailResealCli().catch((error) => {
    console.error(`tail-reseal: ${error.message}`);
    process.exitCode = 1;
  });
}
