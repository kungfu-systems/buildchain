import crypto from "node:crypto";
import { createRunnerProvenance } from "../publication-authority.js";
export function publicationRunnerProvenance(runner) {
  const digest = (value) =>
    crypto.createHash("sha256").update(String(value)).digest("hex");
  if (!runner.os || !runner.architecture)
    throw new Error("Publication runner OS and architecture are required");
  return createRunnerProvenance({
    runnerClass: "ephemeral",
    os: runner.os,
    architecture: runner.architecture,
    imageDigest: digest(
      `${runner.imageOs || "unknown"}|${runner.imageVersion || "unknown"}`,
    ),
    measurementDigest: digest(
      [
        runner.workflow,
        runner.job,
        runner.runId,
        runner.runAttempt,
        runner.environment,
      ].join("|"),
    ),
    isolation: "github-hosted-single-job",
  });
}
