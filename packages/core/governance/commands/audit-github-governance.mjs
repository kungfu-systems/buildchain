#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installationRoot } from "../../runtime/installation-root.js";
import { BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY } from "../github-governance-authority.js";
import { collectGithubGovernanceAudit } from "../audit/collection.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1] || "");
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function main(args = process.argv.slice(2)) {
  const result = collectGithubGovernanceAudit({
    root: installationRoot(import.meta.url), token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    organization: flag(args, "organization", BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization),
    repository: flag(args, "repository"),
    targetRef: flag(args, "target-ref"),
    observedAt: flag(args, "observed-at", new Date().toISOString()),
    ttlMinutes: Number(flag(args, "ttl-minutes", "15")),
    verifierSourceRevision: flag(args, "source-revision"),
  });
  const output = flag(args, "output");
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), serialized);
  if (!output || hasFlag(args, "json")) process.stdout.write(serialized);
  if (hasFlag(args, "require-qualifying") && result.inventory.nonQualifyingCount > 0) {
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
