#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function withoutRoot(value, field = "evidenceRoot") {
  const body = structuredClone(value);
  Reflect.deleteProperty(body, field);
  return body;
}

function requireIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function verifyEvidenceHeader(
  evidence,
  { lifecycleStage, sourceSha, sourceTree, platformId },
) {
  if (evidence?.schema !== "kungfu.lifecycle-substage-evidence/v1") {
    throw new Error(
      `unsupported lifecycle substage evidence schema: ${evidence?.schema || "missing"}`,
    );
  }
  if (!ROOT_PATTERN.test(evidence.evidenceRoot || "")) {
    throw new Error("lifecycle substage evidence root is invalid");
  }
  if (evidence.evidenceRoot !== digest(withoutRoot(evidence))) {
    throw new Error("lifecycle substage evidence root mismatch");
  }
  if (lifecycleStage && evidence.lifecycleStage !== lifecycleStage) {
    throw new Error(
      `lifecycle stage mismatch: expected ${lifecycleStage}, got ${evidence.lifecycleStage}`,
    );
  }
  if (
    !SHA_PATTERN.test(evidence.source?.sha || "") ||
    !SHA_PATTERN.test(evidence.source?.tree || "")
  ) {
    throw new Error("lifecycle substage source identity is invalid");
  }
  if (sourceSha && evidence.source.sha !== sourceSha) {
    throw new Error(
      `lifecycle substage source SHA mismatch: expected ${sourceSha}, got ${evidence.source.sha}`,
    );
  }
  if (sourceTree && evidence.source.tree !== sourceTree) {
    throw new Error(
      `lifecycle substage source tree mismatch: expected ${sourceTree}, got ${evidence.source.tree}`,
    );
  }
  if (platformId && evidence.platform?.id !== platformId) {
    throw new Error(
      `lifecycle substage platform mismatch: expected ${platformId}, got ${evidence.platform?.id}`,
    );
  }
  if (!["passed", "failed"].includes(evidence.conclusion)) {
    throw new Error("lifecycle substage conclusion must be passed or failed");
  }
  requireIso(evidence.startedAt, "lifecycle substage startedAt");
  requireIso(evidence.completedAt, "lifecycle substage completedAt");
  if (!Array.isArray(evidence.substages) || evidence.substages.length === 0) {
    throw new Error("lifecycle substage evidence has no substages");
  }
}

function verifySubstage(substage, index, names) {
  if (typeof substage.stage !== "string" || !substage.stage) {
    throw new Error(`substage ${index} has no name`);
  }
  if (names.has(substage.stage)) {
    throw new Error(`duplicate lifecycle substage: ${substage.stage}`);
  }
  names.add(substage.stage);
  requireIso(substage.startedAt, `${substage.stage}.startedAt`);
  requireIso(substage.completedAt, `${substage.stage}.completedAt`);
  if (
    !Number.isFinite(substage.durationSeconds) ||
    substage.durationSeconds < 0
  ) {
    throw new Error(`${substage.stage}.durationSeconds is invalid`);
  }
  if (
    !Number.isInteger(substage.status) ||
    !["passed", "failed"].includes(substage.conclusion)
  ) {
    throw new Error(`${substage.stage} result is invalid`);
  }
  if ((substage.status === 0) !== (substage.conclusion === "passed")) {
    throw new Error(`${substage.stage} status and conclusion disagree`);
  }
  if (
    !["platform-native", "exact-source-reuse"].includes(substage.executionMode)
  ) {
    throw new Error(`${substage.stage}.executionMode is invalid`);
  }
  if (
    !ROOT_PATTERN.test(substage.evidenceRoot || "") ||
    substage.evidenceRoot !== digest(withoutRoot(substage))
  ) {
    throw new Error(`${substage.stage} evidence root mismatch`);
  }
}

function verifyAggregate(evidence) {
  const failed = evidence.substages.some((substage) => substage.status !== 0);
  const expectedFailureReason = failed
    ? "substage-failed"
    : evidence.conclusion === "failed"
      ? "budget-exceeded"
      : undefined;
  if (
    (failed && evidence.conclusion !== "failed") ||
    (!failed && evidence.conclusion === "passed" && evidence.failureReason) ||
    evidence.failureReason !== expectedFailureReason
  ) {
    throw new Error("lifecycle substage aggregate conclusion is inconsistent");
  }
}

export function verifyLifecycleSubstageEvidence(
  value,
  {
    lifecycleStage = "",
    sourceSha = "",
    sourceTree = "",
    platformId = "",
  } = {},
) {
  const evidence = value?.substageEvidence || value;
  verifyEvidenceHeader(evidence, {
    lifecycleStage,
    sourceSha,
    sourceTree,
    platformId,
  });
  const names = new Set();
  for (const [index, substage] of evidence.substages.entries()) {
    verifySubstage(substage, index, names);
  }
  verifyAggregate(evidence);
  return structuredClone(evidence);
}

export function lifecycleSubstageEvidenceContext({
  substageEvidencePath = "",
  cwd,
  workspace,
  diagnosticsDir,
  lifecycleStage,
  sourceSha = process.env.BUILDCHAIN_SOURCE_SHA || "",
  sourceTree = process.env.BUILDCHAIN_SOURCE_TREE_SHA || "",
  platformId,
}) {
  if (!substageEvidencePath) {
    return {
      evidence: undefined,
      observability: {},
      lifecycle: {},
      links: {},
      sourcePath: "",
      targetPath: "",
      sidecar: {},
    };
  }
  const sourcePath = path.resolve(cwd, substageEvidencePath);
  const targetPath = path.join(diagnosticsDir, "verify-substages.json");
  const relativePath = path
    .relative(workspace, targetPath)
    .split(path.sep)
    .join("/");
  const evidence = readLifecycleSubstageEvidence(sourcePath, {
    lifecycleStage,
    sourceSha,
    sourceTree,
    platformId,
  });
  return {
    evidence,
    observability: {
      substages: {
        contract: evidence.schema,
        evidenceRoot: evidence.evidenceRoot,
        conclusion: evidence.conclusion,
        path: relativePath,
      },
    },
    lifecycle: { substageEvidence: evidence },
    links: { lifecycleSubstages: relativePath },
    sourcePath,
    targetPath,
    sidecar: {
      kind: "lifecycle-substages",
      filePath: targetPath,
      required: true,
    },
  };
}

export function readLifecycleSubstageEvidence(file, options = {}) {
  if (!file) return undefined;
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute))
    throw new Error(`lifecycle substage evidence file not found: ${file}`);
  return verifyLifecycleSubstageEvidence(
    JSON.parse(fs.readFileSync(absolute, "utf8")),
    options,
  );
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || index + 1 >= argv.length)
      throw new Error(`invalid option: ${flag || "missing"}`);
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const evidence = readLifecycleSubstageEvidence(options.file, {
    lifecycleStage: options.stage || "",
    sourceSha: options["source-sha"] || "",
    sourceTree: options["source-tree"] || "",
    platformId: options["platform-id"] || "",
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, evidenceRoot: evidence.evidenceRoot, conclusion: evidence.conclusion })}\n`,
  );
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "lifecycle-substage-evidence.mjs" &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[lifecycle-substages] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
