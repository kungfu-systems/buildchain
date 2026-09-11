import path from "node:path";
import { assertArtifactSigningControlRequestContext } from "./request.js";
import { settleArtifactSigningControl } from "./control.js";
import { artifactNames } from "../artifact/contracts.js";
import { readJson, writeJson } from "../plan/values.js";
export async function controlSigning(context) {
  const {
    plan,
    platform,
    workspace,
    services,
    controller,
    controlToken,
    dispatch,
  } = context;
  const {
    store: { download, downloadNamed, upload },
    downloadBuild,
  } = services;
  const signingRoot = (platform) =>
    path.join(workspace, `.buildchain/signing/${platform.id}`);
  const directory = signingRoot(platform);
  const { get } = await downloadBuild(platform, "", { payload: false });
  await download(get("control"), path.join(directory, "control"));
  const request = assertArtifactSigningControlRequestContext(
    readJson(path.join(directory, "control/request.json")),
    {
      sourceRepository: plan.run.repository,
      sourceRunId: plan.run.id,
      sourceRunAttempt: plan.run.attempt,
      sourceSha: plan.source.sha,
      sourceTreeSha: plan.source.tree_sha,
      runtimeRepository: plan.identity.repository,
      runtimeSha: plan.identity.sha,
      platformId: platform.id,
    },
  );
  let authority = {};
  let failure;
  try {
    if (request.request.count) {
      authority = (
        await dispatch({
          authorityRepository: request.authority.repository,
          runtimeSha: request.runtime.sha,
          sourceRepository: plan.run.repository,
          sourceRunId: plan.run.id,
          sourceRunAttempt: plan.run.attempt,
          requestArtifact: request.request.artifact,
          requestRoot: request.request.root,
          resultArtifact: request.authority.resultArtifact,
          correlationId: request.authority.correlationId,
          timeoutSeconds: 7200,
        })
      ).outputs;
      await downloadNamed(
        plan,
        authority["result-artifact"],
        path.join(directory, "result"),
        {
          repository: request.authority.repository,
          runId: authority["authority-run-id"],
          token: controlToken,
        },
      );
      await download(get("request"), path.join(directory, "request"));
    }
  } catch (error) {
    failure = error;
    authority = error.authorityOutputs || authority;
  }
  const settled = settleArtifactSigningControl({
    request,
    controllerRepository: plan.run.repository,
    controllerRunId: plan.run.id,
    controllerRunAttempt: plan.run.attempt,
    controllerJob: controller.job,
    controllerRunnerOs: controller.runnerOs,
    authorityStatus: request.request.count
      ? failure
        ? "failed"
        : authority["authority-status"]
      : "skipped",
    authorityRunId: authority["authority-run-id"],
    authorityRuntimeSha: request.request.count
      ? authority["authority-runtime-sha"] || ""
      : "",
    authorityRunUrl: authority["authority-run-url"],
    authorityResultArtifact: authority["result-artifact"],
    authorityCorrelationId: request.authority.correlationId,
    authorityConclusion: request.request.count
      ? failure
        ? "controller-error"
        : authority["authority-conclusion"]
      : "not-required",
    receiptPath: path.join(directory, "receipt.json"),
    delegationPath: path.join(directory, "delegation.json"),
  });
  writeJson(path.join(directory, "settlement.json"), { request, ...settled });
  if (failure || !settled.receipt.qualifying) {
    await upload(
      plan,
      `${artifactNames(plan, platform).signing}-failure`,
      ["receipt.json"],
      directory,
    );
    throw failure || new Error("Signing authority did not qualify");
  }
}
