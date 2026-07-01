#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  planTransactionRecovery,
  readPublishEvidence,
  readReleaseTransaction,
  transitionReleaseTransaction,
  validatePublishEvidence,
  writeReleaseTransaction,
} from "../packages/core/publish-transaction.js";

function usage() {
  return `Usage:
  buildchain release inspect --version <tag> [--state-path <path>] [--evidence-path <path>]
  buildchain release recover --version <tag> [--state-path <path>] [--evidence-path <path>] [--override]
  buildchain release finalize --version <tag> [--state-path <path>] [--evidence-path <path>]
  buildchain release abort --version <tag> --superseded-by <tag> [--state-path <path>]

Required creation flags when no state file exists:
  --repository <owner/repo> --source-sha <sha> --release-sha <sha> --target-ref <ref> --channel <channel>

Optional validation flags:
  --release-material-sha <sha> --publish-tooling-sha <sha> --required-artifacts-json <json>
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    return { command: "help" };
  }
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "override") {
      options.override = true;
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    options[key.replaceAll("-", "_")] = next;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  if (!options[key]) {
    throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return options[key];
}

function statePath(options) {
  return path.resolve(options.state_path || defaultReleaseStatePath(requireOption(options, "version")));
}

function evidencePath(options) {
  return path.resolve(options.evidence_path || defaultPublishEvidencePath(requireOption(options, "version")));
}

function loadOrCreate(options) {
  const filePath = statePath(options);
  const existing = readReleaseTransaction(filePath);
  if (existing) {
    return { record: existing, filePath, created: false };
  }
  const record = createReleaseTransaction({
    repository: requireOption(options, "repository"),
    version: requireOption(options, "version"),
    exactTag: options.exact_tag || options.version,
    channel: requireOption(options, "channel"),
    line: options.line || "",
    sourceSha: requireOption(options, "source_sha"),
    targetRef: requireOption(options, "target_ref"),
    releaseSha: requireOption(options, "release_sha"),
    releaseMaterialSha: options.release_material_sha || options.release_sha,
    publishToolingSha: options.publish_tooling_sha || options.release_sha,
    statePath: filePath,
    evidencePath: evidencePath(options),
    actor: process.env.GITHUB_ACTOR || process.env.USER || "",
    runId: process.env.GITHUB_RUN_ID || "",
  });
  writeReleaseTransaction(filePath, record);
  return { record, filePath, created: true };
}

function validateIfPossible(record, options) {
  const evidence = readPublishEvidence(evidencePath(options));
  if (!evidence) {
    return { evidence: undefined, validation: undefined };
  }
  const requiredArtifacts = options.required_artifacts_json
    ? JSON.parse(options.required_artifacts_json)
    : [];
  const validation = validatePublishEvidence({
    evidence,
    version: record.version,
    channel: record.channel,
    sourceSha: record.source_sha,
    releaseSha: record.release_sha,
    targetRef: record.target_ref,
    releaseMaterialSha: record.release_material_sha,
    publishToolingSha: options.publish_tooling_sha || "",
    requiredArtifacts,
  });
  return { evidence, validation };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, options = {} } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (!["inspect", "recover", "finalize", "abort"].includes(command)) {
    throw new Error(`unsupported release transaction command: ${command}`);
  }
  requireOption(options, "version");
  const { record, filePath, created } = loadOrCreate(options);
  const { evidence, validation } = validateIfPossible(record, options);

  if (command === "inspect") {
    printJson({
      command,
      statePath: filePath,
      created,
      transaction: record,
      evidence,
      validation,
    });
    return;
  }

  if (command === "recover") {
    const recovery = planTransactionRecovery({
      transaction: record,
      evidence,
      validation,
      explicitOverride: Boolean(options.override),
    });
    printJson({ command, statePath: filePath, recovery, transaction: record, validation });
    if (recovery.blocked) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "finalize") {
    if (!validation?.valid) {
      throw new Error(`cannot finalize release transaction without valid evidence: ${(validation?.errors || ["missing evidence"]).join("; ")}`);
    }
    const next = transitionReleaseTransaction(
      record.state === "published" ? transitionReleaseTransaction(record, "finalizing") : record,
      "complete",
    );
    writeReleaseTransaction(filePath, next);
    printJson({ command, statePath: filePath, transaction: next, validation });
    return;
  }

  const supersededBy = requireOption(options, "superseded_by");
  const next = transitionReleaseTransaction(record, "abandoned", {
    supersededBy,
    failure: `abandoned in favor of ${supersededBy}`,
  });
  writeReleaseTransaction(filePath, next);
  printJson({ command, statePath: filePath, transaction: next });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
