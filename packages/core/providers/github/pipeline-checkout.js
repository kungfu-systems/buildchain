import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubAuthEnv } from "../source-checkout/auth.js";
import { createNativeChildEnvironment } from "../../dev-delivery/native/execution.js";

// Read-only Git object access for credentialed source qualification. This is a
// bare repository: no consumer checkout, hooks or build scripts are executed.
export async function withPipelineSourceObjects(
  { repository, sourceHead, baseCommit, token },
  operation,
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository || "") ||
    ![sourceHead, baseCommit].every((sha) => /^[0-9a-f]{40}$/u.test(sha || ""))
  )
    throw new Error(
      "Pipeline qualification requires exact repository source coordinates",
    );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-pipeline-source-"),
  );
  const environment = {
    ...createNativeChildEnvironment(process.env),
    GIT_TERMINAL_PROMPT: "0",
    ...githubAuthEnv(token),
  };
  const git = (args) =>
    execFileSync("git", ["-C", directory, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    git(["init", "--bare", "--quiet"]);
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      `https://github.com/${repository}.git`,
      sourceHead,
      baseCommit,
    ]);
    return await operation(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
