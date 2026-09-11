import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { reconcileDevMergeQueue, reconcileConfiguredDevMergeQueue } from "../merge-queue-policy.js";

function createGhApi() {
  return {
    request(method, endpoint, body) {
      const args = [
        "api",
        "--method",
        method,
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ];
      if (body !== undefined) args.push("--input", "-");
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
        env: process.env,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`GitHub API ${method} ${endpoint} failed: ${String(result.stderr || "").trim()}`);
      }
      const output = String(result.stdout || "").trim();
      return output ? JSON.parse(output) : {};
    },
  };
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function loadWorkflowSources(cwd, workflowPaths) {
  return workflowPaths.map((workflowPath) => {
    const absolutePath = path.resolve(cwd, workflowPath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`required workflow not found: ${workflowPath}`);
    }
    return { path: workflowPath, source: fs.readFileSync(absolutePath, "utf8") };
  });
}

async function main(args = process.argv.slice(2)) {
  const cwd = path.resolve(readFlag(args, "cwd", process.cwd()));
  const repository = readFlag(args, "repository", process.env.GITHUB_REPOSITORY || "");
  const branch = readFlag(args, "branch", "");
  if (args.includes("--from-config")) {
    const result = await reconcileConfiguredDevMergeQueue({
      api: createGhApi(),
      repository,
      branch,
      cwd,
      apply: args.includes("--apply"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const workflows = loadWorkflowSources(cwd, readRepeatedFlag(args, "workflow"));
  const result = await reconcileDevMergeQueue({
    api: createGhApi(),
    repository,
    branch,
    workflows,
    apply: args.includes("--apply"),
    checkResponseTimeoutMinutes: readFlag(args, "check-response-timeout-minutes", "120"),
    maxEntriesToBuild: readFlag(args, "max-entries-to-build", "1"),
    bypassApps: readRepeatedFlag(args, "bypass-app"),
    bypassUsers: readRepeatedFlag(args, "bypass-user"),
    bypassTeams: readRepeatedFlag(args, "bypass-team"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`buildchain dev merge-queue: ${error.message}`);
    process.exitCode = 1;
  });
}
