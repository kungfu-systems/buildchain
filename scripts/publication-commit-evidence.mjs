#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "kungfu-buildchain-publication-commit-evidence/v1";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function sha256Root(value, label) {
  const normalized = requiredString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase sha256 root`);
  }
  return normalized;
}

function exactSha(value, label) {
  const normalized = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return normalized;
}

function publicHttps(value, label) {
  const normalized = requiredString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be a public HTTPS URL without credentials, query, or fragment`,
    );
  }
  return normalized;
}

export function validatePublicationCommitEvidence(
  evidence,
  {
    version,
    sourceSha,
    releaseSha,
    releaseTag,
  } = {},
) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("publication commit evidence must be an object");
  }
  if (evidence.schema !== SCHEMA) {
    throw new Error(`publication commit evidence schema must be ${SCHEMA}`);
  }
  if (evidence.status !== "passed") {
    throw new Error("publication commit evidence status must be passed");
  }
  const identity = evidence.identity || {};
  const expected = {
    version: requiredString(version, "expected version"),
    sourceSha: exactSha(sourceSha, "expected sourceSha"),
    releaseSha: exactSha(releaseSha, "expected releaseSha"),
    releaseTag: requiredString(releaseTag, "expected releaseTag"),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) {
      throw new Error(`publication commit evidence ${field} mismatch`);
    }
  }
  const publicUrl = publicHttps(evidence.publication?.url, "publication.url");
  const payloadRoot = sha256Root(
    evidence.publication?.payloadRoot,
    "publication.payloadRoot",
  );
  if (
    evidence.readback?.status !== "passed" ||
    publicHttps(evidence.readback?.url, "readback.url") !== publicUrl ||
    sha256Root(evidence.readback?.payloadRoot, "readback.payloadRoot") !==
      payloadRoot
  ) {
    throw new Error(
      "publication read-back must pass at the canonical URL with the exact payload root",
    );
  }
  const previousAuthority = evidence.recovery?.previousAuthority;
  const rollbackReference = requiredString(
    evidence.recovery?.rollbackReference,
    "recovery.rollbackReference",
  );
  if (!["preserved", "none"].includes(previousAuthority)) {
    throw new Error(
      "publication recovery must preserve or explicitly declare no previous authority",
    );
  }
  return {
    schema: SCHEMA,
    status: "passed",
    publicUrl,
    payloadRoot,
    identity: expected,
    recovery: {
      previousAuthority,
      rollbackReference,
    },
  };
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--evidence") options.evidence = args[++index];
    else if (value === "--version") options.version = args[++index];
    else if (value === "--source-sha") options.sourceSha = args[++index];
    else if (value === "--release-sha") options.releaseSha = args[++index];
    else if (value === "--release-tag") options.releaseTag = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  const evidencePath = path.resolve(
    requiredString(options.evidence, "--evidence"),
  );
  const result = validatePublicationCommitEvidence(
    JSON.parse(fs.readFileSync(evidencePath, "utf8")),
    options,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `publication commit evidence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
