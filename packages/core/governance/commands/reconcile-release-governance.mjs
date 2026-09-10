#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { reconcileReleaseGovernance } from "../release-reconciliation.js";
function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function apiToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  return token;
}

function usage() {
  return `Usage:
  buildchain release-governance reconcile --repository <owner/repo>
      --branch <dev|alpha|release/vN/vN.N> --candidate-sha <sha> [--apply] [--json]
`;
}

export async function runReleaseGovernanceCli(argv = process.argv.slice(2)) {
  const [mode = "", ...args] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (mode !== "reconcile") {
    throw new Error(`unsupported release-governance command: ${mode}`);
  }
  const result = await reconcileReleaseGovernance({
    repository: readFlag(
      args,
      "repository",
      process.env.GITHUB_REPOSITORY || "",
    ),
    branch: readFlag(args, "branch"),
    candidateSha: readFlag(args, "candidate-sha"),
    apply: hasFlag(args, "apply"),
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com", token: apiToken(),
  });
  if (hasFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release governance ${result.status}: ${result.repository} ${result.branch}\n`,
    );
    process.stdout.write(`- expected: ${result.expected.context}\n`);
    process.stdout.write(
      `- actual: ${result.actual.map((entry) => entry.context).join(", ") || "none"}\n`,
    );
    process.stdout.write(`- candidate: ${result.candidateSha}\n`);
    process.stdout.write(
      result.applied
        ? "Required status checks were reconciled without changing other branch-protection settings.\n"
        : "No branch-protection settings were modified.\n",
    );
  }
  return result;
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReleaseGovernanceCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
