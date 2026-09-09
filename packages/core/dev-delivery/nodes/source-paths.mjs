import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { githubAuthEnv } from "../../providers/commands/locked-source-checkout.mjs";
import { devDeliveryContentRoot } from "../dev-delivery-common.js";
import { verifySourceQualificationProof } from "../dev-delivery-proof.js";
import { readEvidence } from "./io.mjs";

export function qualifiedRunBase(run, env) {
  const pull = run.pull_requests?.find(
    (item) => item.number === Number(env.EXPECTED_PR),
  );
  requireValue(
    run.conclusion === "success" &&
      run.event === "pull_request" &&
      run.head_sha === env.EXPECTED_HEAD &&
      pull &&
      /^[0-9a-f]{40}$/u.test(pull.base?.sha || ""),
    "Affected paths require a successful source run for the exact PR head",
  );
  return pull.base.sha;
}

export function pathsAtQualifiedSource(directory, qualifiedBase, env) {
  const git = (args) =>
    command("git", ["-C", directory, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  const sourceTree = git(["rev-parse", `${env.EXPECTED_HEAD}^{tree}`]);
  requireValue(
    devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-identity/v1",
      repository: env.GITHUB_REPOSITORY,
      protectedBase: env.TARGET_BRANCH,
      qualifiedBase,
      sourceHead: env.EXPECTED_HEAD,
      sourceTree,
    }) === env.SOURCE_IDENTITY_ROOT,
    "Affected path source identity root drift",
  );
  return git([
    "diff",
    "--name-only",
    "--no-renames",
    `${qualifiedBase}...${env.EXPECTED_HEAD}`,
  ])
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

export function deriveSourcePaths(env) {
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY || "") &&
      /^[0-9a-f]{40}$/u.test(env.EXPECTED_HEAD || "") &&
      /^[1-9]\d*$/u.test(env.SOURCE_WORKFLOW_RUN_ID || ""),
    "Exact source run coordinates are required",
  );
  const run = JSON.parse(
    command(
      "gh",
      [
        "api",
        `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.SOURCE_WORKFLOW_RUN_ID}`,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, GH_TOKEN: env.GH_TOKEN },
      },
    ),
  );
  const qualifiedBase = qualifiedRunBase(run, env);
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
        `https://github.com/${env.GITHUB_REPOSITORY}.git`,
        qualifiedBase,
        env.EXPECTED_HEAD,
      ],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...githubAuthEnv(env.GH_TOKEN),
        },
      },
    );
    return JSON.stringify(
      pathsAtQualifiedSource(directory, qualifiedBase, env),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function sourceProofPaths(
  env,
  readProof = () => readEvidence("source-proof.json"),
) {
  const supplied = JSON.parse(env.AFFECTED_PATHS || "[]");
  requireValue(Array.isArray(supplied), "Affected paths must be an array");
  if (supplied.length) return env.AFFECTED_PATHS;
  const proof = readProof();
  requireValue(
    proof.proofRoot === env.SOURCE_PROOF_ROOT,
    "Affected path proof does not match the admitted source proof root",
  );
  const verification = verifySourceQualificationProof(proof, {
    repository: env.GITHUB_REPOSITORY,
    protectedBase: env.TARGET_BRANCH,
    sourceHead: env.EXPECTED_HEAD,
    sourceIdentityRoot: env.SOURCE_IDENTITY_ROOT,
  });
  requireValue(
    verification.ok,
    `Affected path proof failed: ${verification.reason}`,
  );
  return JSON.stringify(proof.affectedPaths);
}
