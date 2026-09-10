import {
  prepareCredential,
  publishCredential,
} from "./credential-transaction.js";
import { controlSigning } from "./controller-transaction.js";
import fs from "node:fs";
import path from "node:path";
import { assertArtifactSigningControllerReceipt } from "./control.js";
import { importArtifactSigningResults } from "./import-results.js";
import { artifactNames, verifyManifest } from "../artifact/contracts.js";
import { lifecycleOptions } from "../plan/lifecycle.js";
import { commonEnv } from "../plan/environment.js";
import { readJson, rootOf, writeJson } from "../plan/values.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
async function finalizeSigning(context) {
  const {
    plan,
    platform,
    workspace,
    sourceRoot,
    services,
    consumerEnvironment,
    executeConsumer,
    executeLifecycle,
  } = context;
  const {
    store: { publishRecord, upload },
    downloadBuild,
    cleanupRelay,
  } = services;
  const signingRoot = (platform) =>
    path.join(workspace, `.buildchain/signing/${platform.id}`);
  const directory = signingRoot(platform);
  const { request, receipt, delegation } = readJson(
    path.join(directory, "settlement.json"),
  );
  assertArtifactSigningControllerReceipt({ request, receipt, delegation });
  await downloadBuild(platform, sourceRoot);
  const manifest = path.join(
    sourceRoot,
    `.buildchain/artifacts/${platform.id}/manifest.json`,
  );
  if (request.request.count) {
    fs.copyFileSync(
      manifest,
      manifest.replace("manifest.json", "manifest-pre-signing.json"),
    );
    importArtifactSigningResults({
      workspace: sourceRoot,
      cwd: plan.project.cwd,
      requestRoot: path.join(directory, "request"),
      resultRoot: path.join(directory, "result"),
      evidenceRoot: ".buildchain/artifacts/signing",
    });
  }
  const session = consumerCommandSession(consumerEnvironment);
  const env = commonEnv(plan, platform);
  if (plan.build.finalization.command) {
    await session.phase(
      (phaseEnv) =>
        executeConsumer({
          command: plan.build.finalization.command,
          cwd: path.join(sourceRoot, plan.project.cwd),
          env: phaseEnv,
        }),
      {
        ...env,
        BUILDCHAIN_SIGNING_REQUEST_COUNT: String(request.request.count),
        BUILDCHAIN_ARTIFACT_SIGNING_STATE: request.request.count
          ? "signed"
          : "unsigned",
      },
    );
  }
  if (request.request.count || plan.build.finalization.command) {
    await session.phase(
      (phaseEnv) =>
        executeLifecycle({
          ...lifecycleOptions(
            plan,
            platform,
            "signing-finalization",
            sourceRoot,
          ),
          env: phaseEnv,
        }),
      env,
    );
  }
  verifyManifest(manifest, sourceRoot, plan, platform);
  const names = artifactNames(plan, platform);
  const finalManifest = readJson(manifest);
  finalManifest.artifactName = names.final;
  writeJson(manifest, finalManifest);
  const payload = await upload(
    plan,
    names.final,
    [
      ...plan.artifacts.paths.split("\n"),
      `.buildchain/artifacts/${platform.id}`,
      ".buildchain/artifacts/signing",
    ],
    sourceRoot,
  );
  const result = {
    schema: "buildchain.build-signing/v1",
    plan_root: plan.root,
    platform: platform.id,
    status: "success",
    state: request.request.count ? "signed" : "unsigned",
    payload,
    controller: receipt,
  };
  await publishRecord(
    plan,
    names.signing,
    { ...result, root: rootOf(result) },
    path.join(directory, "record"),
  );
  await cleanupRelay(platform);
  return payload;
}
export function createBuildSigningService(
  {
    plan,
    platform,
    workspace,
    sourceRoot,
    services,
    controller,
    consumerEnvironment,
  },
  { controlToken, dispatch, executeConsumer, executeLifecycle },
) {
  const context = {
    plan,
    platform,
    workspace,
    sourceRoot,
    services,
    controller,
    consumerEnvironment,
    controlToken,
    dispatch,
    executeConsumer,
    executeLifecycle,
  };
  return {
    controlSigning: () => controlSigning(context),
    finalizeSigning: () => finalizeSigning(context),
    prepareCredential: () => prepareCredential(context),
    publishCredential: (request) => publishCredential(context, request),
    async completeSigning() {
      await controlSigning(context);
      return finalizeSigning(context);
    },
  };
}
