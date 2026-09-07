import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyPublicationSettlement } from "./v4-publication-settlement.mjs";
import {
  verifyComposePublication,
  verifyComposeQualification,
} from "../packages/core/oci-compose-qualification.js";
import { releaseTailRoot } from "../packages/core/release-tail-provider-plane.js";
import { createRegistryClient } from "../actions/v4-release-candidate-promote/oci-registry-client.js";
import { ociPublicationTag } from "../packages/core/oci-publication-graph.js";

const digest = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function check(condition, message) {
  if (!condition) throw new Error(`Compose preview: ${message}`);
}
function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const api = (route) => JSON.parse(gh(["api", route]));
const read = (file) => JSON.parse(fs.readFileSync(file));
export function createComposePreviewRegistry(environment, fetchImpl = fetch) {
  const token = environment.BUILDCHAIN_REGISTRY_TOKEN;
  const actor = environment.GITHUB_ACTOR;
  check(
    typeof token === "string" &&
      token.length > 0 &&
      typeof actor === "string" &&
      actor.length > 0,
    "explicit scoped registry identity required",
  );
  return createRegistryClient(token, fetchImpl, actor);
}
function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function promoteComposePreview({
  context,
  registry,
  receipt,
  fetchManifest,
}) {
  const { application, policy } = context;
  const exact = await fetchManifest(
    ociPublicationTag(application, context.tag.slice(1)),
  );
  check(
    exact.digest === application.digest,
    "immutable application digest changed",
  );
  const current = await fetchManifest(policy.alias, true);
  check(
    current.digest === policy.previousDigest ||
      current.digest === application.digest,
    "preview changed since qualification",
  );
  const plan = {
    schema: "kungfu-buildchain-compose-preview-plan/v1",
    ...context,
    qualificationRoot: releaseTailRoot(receipt),
    expectedOld: policy.previousDigest,
    targetDigest: application.digest,
    operation: "digest-preserving-preview-promotion",
  };
  if (current.digest !== application.digest) {
    const result = await registry(application, `manifests/${policy.alias}`, {
      write: true,
      method: "PUT",
      body: exact.bytes,
      headers: {
        "content-type": exact.mediaType,
        "content-length": String(exact.bytes.length),
      },
    });
    check(
      result.status === 201,
      `preview write uncertain (HTTP ${result.status}); retain the original qualification for readback`,
    );
  }
  const observed = await fetchManifest(policy.alias);
  check(observed.digest === application.digest, "preview readback mismatch");
  const body = {
    schema: "kungfu-buildchain-compose-preview-receipt/v1",
    repository: context.repository,
    tag: context.tag,
    sourceSha: context.sourceSha,
    publicationReceiptRoot: context.publicationReceiptRoot,
    planRoot: releaseTailRoot(plan),
    qualificationRoot: plan.qualificationRoot,
    previousDigest: policy.previousDigest,
    application: `${application.repository}@${application.digest}`,
    alias: `${application.repository}:${policy.alias}`,
    observedDigest: observed.digest,
    outcome: "complete",
  };
  return { ...body, receiptRoot: releaseTailRoot(body) };
}

async function run(mode) {
  const repository = process.env.GITHUB_REPOSITORY,
    event = read(process.env.GITHUB_EVENT_PATH);
  check(
    process.env.GITHUB_EVENT_NAME === "workflow_run" && event.workflow_run?.id,
    "requires a completed qualification workflow event",
  );
  check(
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository),
    "invalid repository",
  );
  const id = String(event.workflow_run.id);
  check(/^\d+$/u.test(id), "invalid qualification run");
  const run = api(`repos/${repository}/actions/runs/${id}`),
    tag = run.head_branch;
  check(
    /^v\d+\.\d+\.\d+-alpha\.\d+$/u.test(tag),
    "qualification must run on an exact alpha tag",
  );
  const release = api(`repos/${repository}/releases/tags/${tag}`);
  check(release.prerelease && !release.draft, "public alpha release required");
  const root = path.resolve(".buildchain/compose-preview");
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  const names = [
    "oci-family.json",
    "oci-publication-readback.json",
    "buildchain-publication-settlement.json",
    "buildchain.release.json",
  ];
  for (const name of names) {
    check(
      release.assets.filter((asset) => asset.name === name).length === 1,
      `missing exact public asset ${name}`,
    );
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      name,
      "--dir",
      path.join(root, "public"),
      "--clobber",
    ]);
  }
  const [family, readback, settlement, publicPassport] = names.map((name) =>
    read(path.join(root, "public", name)),
  );
  const documents = settlement.documents;
  const tagged = api(`repos/${repository}/commits/${tag}`).sha;
  verifyPublicationSettlement(documents, {
    repository,
    tag,
    sourceSha: tagged,
    publicPassport,
  });
  const context = verifyComposePublication({
    family,
    readback,
    documents,
    repository,
    tag,
  });
  verifyComposeQualification(context, run);
  const artifactName = `oci-compose-qualification-${id}-${run.run_attempt}`;
  const artifacts = api(
    `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`,
  ).artifacts.filter(
    (artifact) => artifact.name === artifactName && !artifact.expired,
  );
  check(
    artifacts.length === 1,
    "qualification artifact is missing or ambiguous",
  );
  if (mode === "prepare") {
    output("artifact-id", artifacts[0].id);
    output("run-id", id);
    output("source-sha", tagged);
    return;
  }
  check(mode === "apply", "unsupported mode");
  const evidenceRoot = path.join(root, "qualification");
  const receipt = read(path.join(evidenceRoot, "qualification.json"));
  verifyComposeQualification(context, run, receipt);
  for (const item of receipt.evidence) {
    const file = path.join(evidenceRoot, item.path);
    check(
      !fs.lstatSync(file).isSymbolicLink() &&
        fs.statSync(file).size < 2_000_000 &&
        digest(fs.readFileSync(file)) === item.sha256,
      "qualification evidence bytes mismatch",
    );
  }
  const { registry } = createComposePreviewRegistry(process.env);
  async function fetchManifest(ref, allowAbsent = false) {
    const response = await registry(context.application, `manifests/${ref}`, {
      headers: {
        accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json",
      },
    });
    if (allowAbsent && response.status === 404) return { digest: "none" };
    check(response.ok, "public registry readback unavailable");
    const bytes = Buffer.from(await response.arrayBuffer()),
      value = digest(bytes);
    check(
      !response.headers.get("docker-content-digest") ||
        response.headers.get("docker-content-digest") === value,
      "registry digest mismatch",
    );
    return { bytes, digest: value, mediaType: JSON.parse(bytes).mediaType };
  }
  const result = await promoteComposePreview({
    context,
    registry,
    receipt,
    fetchManifest,
  });
  const file = path.join(
    root,
    `buildchain-compose-preview-${id}-${run.run_attempt}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  const existing = release.assets.find(
    (asset) => asset.name === path.basename(file),
  );
  if (existing) {
    const previous = path.join(root, "previous");
    fs.mkdirSync(previous, { recursive: true });
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      path.basename(file),
      "--dir",
      previous,
      "--clobber",
    ]);
    check(
      fs.readFileSync(path.join(previous, path.basename(file)), "utf8") ===
        fs.readFileSync(file, "utf8"),
      "existing preview receipt conflict",
    );
  } else gh(["release", "upload", tag, file, "--repo", repository]);
  process.stdout.write(`Verified ${result.alias}@${result.observedDigest}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
