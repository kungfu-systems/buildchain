import { pipelineHost } from "./host.js";
import { recordPipelineBuild } from "./build-control.js";
import { publishRecorderStatus } from "./recorder-status.js";
import {
  RECOVERY_BUILD_CONTEXT,
  recordRecoveryBuild,
} from "./recovery-build-control.js";

export async function recordPipelineBuildAction(core, env) {
  const host = await pipelineHost(core, env, "Record product build");
  host.publishBuildStatus = (context, readback) =>
    publishRecorderStatus(context, readback, host);
  const context = JSON.parse(core.getInput("context", { required: true }));
  if (context.schema === "buildchain.pipeline-group-build-context/v1")
    return host.groupRecord(context);
  const result =
    context.schema === RECOVERY_BUILD_CONTEXT
      ? await recordRecoveryBuild(context, host)
      : await recordPipelineBuild(context, host);
  if (result.outcome !== "success")
    throw new Error("Product build did not succeed");
  core.info(
    result.wakePending
      ? "Build retained; next event will retry delivery wake"
      : "Build retained and attempt woken",
  );
}
