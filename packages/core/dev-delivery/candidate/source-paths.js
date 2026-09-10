import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { githubAuthEnv } from "../../providers/source-checkout/auth.js";
import { devDeliveryContentRoot } from "../dev-delivery-common.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
export function qualifiedRunBase(run, source) {
  const pull = run.pull_requests?.find(
    (item) => item.number === Number(source.pullRequestNumber),
  );
  requireValue(
    run.conclusion === "success" &&
      run.event === "pull_request" &&
      run.head_sha === source.expectedHead &&
      pull &&
      /^[0-9a-f]{40}$/u.test(pull.base?.sha || ""),
    "Affected paths require a successful source run for the exact PR head",
  );
  return pull.base.sha;
}

export function pathsAtQualifiedSource(directory, qualifiedBase, source) {
  const git = (args) =>
    command("git", ["-C", directory, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  const sourceTree = git(["rev-parse", `${source.expectedHead}^{tree}`]);
  requireValue(
    devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-identity/v1",
      repository: source.repository,
      protectedBase: source.branch,
      qualifiedBase,
      sourceHead: source.expectedHead,
      sourceTree,
    }) === source.sourceIdentityRoot,
    "Affected path source identity root drift",
  );
  return git([
    "diff",
    "--name-only",
    "--no-renames",
    `${qualifiedBase}...${source.expectedHead}`,
  ])
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

export async function deriveSourcePaths(
  source,
  { token, apiUrl, environment = process.env },
  provider = new GitHubTwoPhaseClient({
    repository: source.repository,
    token,
    apiUrl,
  }),
) {
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository || "") &&
      /^[0-9a-f]{40}$/u.test(source.expectedHead || "") &&
      /^[1-9]\d*$/u.test(String(source.sourceWorkflowRunId || "")),
    "Exact source run coordinates are required",
  );
  const run = await provider.request(
    `/repos/${source.repository}/actions/runs/${source.sourceWorkflowRunId}`,
  );
  const qualifiedBase = qualifiedRunBase(run, source);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-source-paths-"),
  );
  try {
    command("git", ["init", "--bare", "--quiet", directory]);
    command(
      "git",
      [
        "-C",
        directory,
        "fetch",
        "--quiet",
        "--no-tags",
        "--filter=blob:none",
        `https://github.com/${source.repository}.git`,
        qualifiedBase,
        source.expectedHead,
      ],
      {
        env: {
          ...environment,
          GIT_TERMINAL_PROMPT: "0",
          ...githubAuthEnv(token),
        },
      },
    );
    return pathsAtQualifiedSource(directory, qualifiedBase, source);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
