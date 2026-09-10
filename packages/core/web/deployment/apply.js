import { compactProductionReleasePrSummary } from "../release-pr-summary.js";
import fs from "node:fs";
import path from "node:path";
import { transactionJournal } from "../../observability/transaction-journal.js";
import {
  applyWebSurfaceCleanup,
  applyWebSurfaceDeploy,
  preflightWebSurfaceProduction,
  checkWebSurfaceHealth,
} from "../commands/web-surface-core.mjs";
import { exactWebPlan } from "./plan-files.js";
import {
  writeJson,
  writeFailureResult,
  assertApplySucceeded,
  compactWebSurfaceApplyResult,
} from "./apply-evidence.js";
import { waitForCloudFrontInvalidations } from "./cloudfront-wait.js";

export async function applyWebDeployment(request, emit = () => {}, ports = {}) {
  const { workspace, channel, actor, runId, workingDirectory, healthPolicy } =
    request;
  if (!["preview", "staging", "production", "cleanup"].includes(channel))
    throw new Error("Unknown Web deployment channel");
  if (!path.isAbsolute(workspace || ""))
    throw new Error("Web deployment requires an explicit absolute workspace");
  const cwd = path.resolve(workspace, workingDirectory);
  const resultPath = path.join(
    workspace,
    `.buildchain/web-surface-${channel}-apply.json`,
  );
  const journal = transactionJournal(
    path.join(workspace, `.buildchain/web-surface-${channel}-execution.json`),
    ["preflight", "apply", "health"],
  );
  const planPath = exactWebPlan(
    path.join(workspace, ".buildchain/downloaded-plans"),
    `web-surface-${channel}-plan.json`,
  );
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (channel === "production")
    await journal.observe("preflight", async () => {
      const preflight = await (
        ports.preflight || preflightWebSurfaceProduction
      )({ cwd, plan, execute: true });
      writeJson(
        preflight,
        path.join(
          workspace,
          ".buildchain/web-surface-production-preflight.json",
        ),
      );
      if (preflight.status !== "passed")
        throw new Error("Web production readiness preflight did not pass");
    });
  let result;
  try {
    result = await journal.observe("apply", async () => {
      const apply =
        channel === "cleanup"
          ? ports.cleanup || applyWebSurfaceCleanup
          : ports.deploy || applyWebSurfaceDeploy;
      const applied = await apply({
        cwd,
        channel,
        plan,
        dryRun: false,
        actor,
        runId,
      });
      writeJson(applied, resultPath);
      if (channel === "cleanup")
        emit({ "web-surface-cleanup-result-json": JSON.stringify(applied) });
      else
        emit({
          "web-surface-apply-result-json": JSON.stringify(
            compactWebSurfaceApplyResult(applied),
          ),
        });
      assertApplySucceeded(applied);
      return applied;
    });
  } catch (error) {
    writeFailureResult({
      output: resultPath,
      mode: channel === "cleanup" ? "cleanup-apply" : "deploy-apply",
      cwd,
      error,
    });
    throw error;
  } finally {
    emit({ "apply-outcome": journal.stages.apply?.status || "skipped" });
  }
  if (channel !== "cleanup")
    await journal.observe("health", async () => {
      await (ports.wait || waitForCloudFrontInvalidations)(result);
      const health = await (ports.health || checkWebSurfaceHealth)({
        cwd,
        result,
        ...healthPolicy,
      });
      writeJson(
        health,
        path.join(workspace, `.buildchain/web-surface-${channel}-health.json`),
      );
      if (health.status !== "passed")
        throw new Error("Web deployment health check did not pass");
    });
  if (channel === "staging")
    writeJson(
      compactProductionReleasePrSummary(result),
      path.join(
        workspace,
        ".buildchain/web-surface-staging-release-pr-summary.json",
      ),
    );
  return result;
}
