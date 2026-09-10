import { selectWebOutputs } from "./plan-files.js";
import path from "node:path";
import { transactionJournal } from "../../observability/transaction-journal.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import {
  validateWebSurfaceProject,
  defaultWebSurfaceAlias,
  planWebSurfaceDeploy,
  planWebSurfaceCleanup,
} from "../commands/web-surface-core.mjs";
import { writeJson } from "./apply-evidence.js";

export async function buildWebDeployment(
  { request, runtime, intent, selection, event, workspace },
  emit = () => {},
  ports = {},
) {
  if (!path.isAbsolute(workspace || ""))
    throw new Error("Web planning requires an absolute runner workspace");
  if (
    typeof request["working-directory"] !== "string" ||
    !request["working-directory"]
  )
    throw new Error("Web planning requires a working directory");
  const cwd = path.resolve(workspace, request["working-directory"]),
    channel = selection["web-surface-channel"] || "",
    alias = selection["web-surface-alias"] || "";
  if (!["", "preview", "staging", "production"].includes(channel))
    throw new Error("Unadmitted Web channel");
  const journal = transactionJournal(
    path.join(workspace, ".buildchain/web-surface-plan-execution.json"),
    ["build", "verify", "validate", "plan"],
  );
  const consumer = consumerCommandSession();
  const consume =
    ports.consume || ((options) => consumer.run(options, ports.execute));
  const env = {
    BUILDCHAIN_WEB_SURFACE_CHANNEL: channel,
    BUILDCHAIN_SURFACE_CHANNEL: channel,
    BUILDCHAIN_PREVIEW_ALIAS: alias,
    BUILDCHAIN_WEB_SURFACE_ALIAS: alias,
    BUILDCHAIN_SITE_SOURCE_SHA: intent["production-source-sha"],
  };
  try {
    if (channel && request["build-command"])
      await journal.observe("build", () =>
        consume({ script: request["build-command"], cwd, env }),
      );
    if (channel && request["verify-command"])
      await journal.observe("verify", () =>
        consume({ script: request["verify-command"], cwd, env }),
      );
    await journal.observe("validate", () =>
      (ports.validate || validateWebSurfaceProject)(cwd),
    );
    return await journal.observe("plan", () => {
      const cleanup =
        event.name === "pull_request" &&
        event.payload.action === "closed" &&
        intent["production-release-approved"] !== "true";
      if (cleanup) {
        const plan = (ports.cleanup || planWebSurfaceCleanup)({
          cwd,
          channel: "preview",
          event: "pull-request-closed",
          sourceSha: event.payload.pull_request.head.sha,
          pullNumber: String(event.payload.pull_request.number),
          dryRun: false,
          actor: event.actor,
          runId: event.runId,
        });
        writeJson(
          plan,
          path.join(workspace, ".buildchain/web-surface-cleanup-plan.json"),
        );
        return selectWebOutputs(workspace);
      }
      if (
        !channel ||
        (channel === "preview" && event.payload.action === "closed")
      )
        return selectWebOutputs(workspace);
      const sourceSha =
        channel === "preview"
          ? event.payload.pull_request.head.sha
          : intent["production-source-sha"];
      const selectedAlias =
        alias ||
        defaultWebSurfaceAlias({
          channel,
          sourceSha,
          pullNumber: event.payload.pull_request?.number || "",
        });
      const plan = (ports.plan || planWebSurfaceDeploy)({
        cwd,
        channel,
        alias: selectedAlias,
        sourceSha,
        artifactPath: request["artifact-path"],
        runtimeId: runtime["runtime-sha"],
        rollbackPointer: runtime["rollback-ref"],
        rollbackLimitations:
          "Buildchain runtime override changes cannot validate outer reusable workflow YAML topology.",
        dryRun: true,
        ...(consumer.environment.BUILDCHAIN_SITE_GENERATED_AT ||
        consumer.environment.BUILDCHAIN_SURFACE_GENERATED_AT
          ? {
              deployedAt:
                consumer.environment.BUILDCHAIN_SITE_GENERATED_AT ||
                consumer.environment.BUILDCHAIN_SURFACE_GENERATED_AT,
            }
          : {}),
      });
      writeJson(
        plan,
        path.join(workspace, `.buildchain/web-surface-${channel}-plan.json`),
      );
      return selectWebOutputs(workspace);
    });
  } finally {
    emit({
      "build-outcome": journal.stages.build?.status || "skipped",
      "verify-outcome": journal.stages.verify?.status || "skipped",
    });
  }
}
