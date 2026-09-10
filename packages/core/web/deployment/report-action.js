import fs from "node:fs";
import path from "node:path";
import { deploymentSummary } from "./summary.js";
import { reportWebRelease } from "../release-feedback.js";
const read = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;

export async function webDeploymentReportAction(core, env) {
  const channel = core.getInput("channel", { required: true });
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const workspace = env.GITHUB_WORKSPACE;
  if (!path.isAbsolute(workspace || ""))
    throw new Error("Deployment report requires an explicit runner workspace");
  const failures = [];
  try {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      deploymentSummary(channel, workspace),
    );
  } catch (error) {
    failures.push(error);
  }
  if (["staging", "production"].includes(channel)) {
    try {
      const file = (kind) =>
        path.join(workspace, `.buildchain/web-surface-${channel}-${kind}.json`);
      const journal = read(file("execution"));
      await reportWebRelease({
        channel,
        request,
        runtime: {
          sha: core.getInput("runtime-sha"),
          rollbackPointer: core.getInput("rollback-pointer"),
        },
        intent: {
          productionReleasePr: core.getInput("release-pr"),
          productionReleaseSource: core.getInput("release-source"),
        },
        event: {
          payload: read(env.GITHUB_EVENT_PATH),
          repository: env.GITHUB_REPOSITORY,
          sha: env.GITHUB_SHA,
          name: env.GITHUB_EVENT_NAME,
          actor: env.GITHUB_ACTOR,
          triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
          runner: env.RUNNER_NAME,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
          serverUrl: env.GITHUB_SERVER_URL,
          apiUrl: env.GITHUB_API_URL,
        },
        result: read(file("apply")),
        productionPreflight: read(file("preflight")),
        healthCheck: read(file("health")),
        applyOutcome:
          journal?.apply?.status === "running"
            ? core.getInput("job-status") === "cancelled"
              ? "cancelled"
              : "failure"
            : journal?.apply?.status || "skipped",
        jobStatus: core.getInput("job-status"),
        outputPath: file("release-passport"),
        token: core.getInput("token"),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures.map((error) => error.message).join("; "),
    );
}
