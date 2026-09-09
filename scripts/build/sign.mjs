import fs from "node:fs";
import path from "node:path";
import { assertArtifactSigningControlRequestContext } from "../artifact-signing-controller-core.mjs";
import { assertArtifactSigningControllerReceipt, settleArtifactSigningControl } from "../artifact-signing-controller.mjs";
import { importArtifactSigningResults } from "../import-artifact-signing-results.mjs";
import { runLifecycle } from "../run-lifecycle-core.mjs";
import { lifecycleOptions } from "./stage.mjs";
import { artifactNames, verifyManifest, verifyCredential } from "./artifact-contract.mjs";
import { download, downloadNamed, publishRecord, upload } from "./artifact-store.mjs";
import { downloadBuild, cleanupRelay, downloadCredential, cleanupCredentialRelay } from "./transfer.mjs";
import { commonEnv, context, execute, main, output, readJson, rootOf, script, sourceRoot, workspace, writeJson } from "./context.mjs";

const signingRoot = (platform) => path.join(workspace, `.buildchain/signing/${platform.id}`);
export async function controlSigning() {
  const { plan, platform } = context();
  const directory = signingRoot(platform);
  const { get } = await downloadBuild(plan, platform, "", { payload: false });
  await download(get("control"), path.join(directory, "control"));
  const request = assertArtifactSigningControlRequestContext(readJson(path.join(directory, "control/request.json")), {
    sourceRepository: plan.run.repository, sourceRunId: plan.run.id, sourceRunAttempt: plan.run.attempt,
    sourceSha: plan.source.sha, sourceTreeSha: plan.source.tree_sha, runtimeRepository: plan.identity.repository,
    runtimeSha: plan.identity.sha, platformId: platform.id });
  let authority = {};
  let failure;
  try {
    if (request.request.count) {
      authority = await script("dispatch-artifact-signing-authority.mjs", {
        BUILDCHAIN_AUTHORITY_DISPATCH_TOKEN: process.env.BUILDCHAIN_CONTROL_TOKEN,
        BUILDCHAIN_AUTHORITY_REPOSITORY: request.authority.repository, BUILDCHAIN_AUTHORITY_REF: request.runtime.ref,
        BUILDCHAIN_RUNTIME_SHA: request.runtime.sha, BUILDCHAIN_SIGNING_REQUEST_ARTIFACT: request.request.artifact,
        BUILDCHAIN_SIGNING_REQUEST_ROOT_DIGEST: request.request.root, BUILDCHAIN_SIGNING_RESULT_ARTIFACT: request.authority.resultArtifact,
        BUILDCHAIN_AUTHORITY_CORRELATION_ID: request.authority.correlationId, BUILDCHAIN_SIGNING_TIMEOUT_SECONDS: 7200,
      });
      await downloadNamed(plan, authority["result-artifact"], path.join(directory, "result"), {
        repository: request.authority.repository, runId: authority["authority-run-id"], token: process.env.BUILDCHAIN_CONTROL_TOKEN });
      await download(get("request"), path.join(directory, "request"));
    }
  } catch (error) { failure = error; }
  const settled = settleArtifactSigningControl({ request, authorityStatus: request.request.count ? (failure ? "failed" : authority["authority-status"]) : "skipped",
    authorityRunId: authority["authority-run-id"], authorityRuntimeSha: request.request.count ? (authority["authority-runtime-sha"] || plan.identity.sha) : "",
    authorityRunUrl: authority["authority-run-url"], authorityResultArtifact: authority["result-artifact"],
    authorityCorrelationId: request.authority.correlationId, authorityConclusion: request.request.count ? (failure ? "controller-error" : authority["authority-conclusion"]) : "not-required",
    receiptPath: path.join(directory, "receipt.json"), delegationPath: path.join(directory, "delegation.json") });
  writeJson(path.join(directory, "settlement.json"), { request, ...settled });
  if (failure || !settled.receipt.qualifying) {
    await upload(plan, `${artifactNames(plan, platform).signing}-failure`, ["receipt.json"], directory);
    throw failure || new Error("Signing authority did not qualify");
  }
}

export async function finalizeSigning() {
  const { plan, platform } = context();
  const directory = signingRoot(platform);
  const { request, receipt, delegation } = readJson(path.join(directory, "settlement.json"));
  assertArtifactSigningControllerReceipt({ request, receipt, delegation });
  await downloadBuild(plan, platform, sourceRoot);
  const manifest = path.join(sourceRoot, `.buildchain/artifacts/${platform.id}/manifest.json`);
  if (request.request.count) {
    fs.copyFileSync(manifest, manifest.replace("manifest.json", "manifest-pre-signing.json"));
    importArtifactSigningResults({ workspace: sourceRoot, cwd: plan.project.cwd, requestRoot: path.join(directory, "request"),
      resultRoot: path.join(directory, "result"), evidenceRoot: ".buildchain/artifacts/signing" });
  }
  // This process has no signing token or certificate inputs. Consumer policy
  // runs only in the ordinary artifact instance, never the credential instance.
  const env = commonEnv(plan, platform);
  if (plan.build.finalization.command) {
    await execute(process.platform === "win32" ? "pwsh" : "bash", process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", plan.build.finalization.command]
      : ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", plan.build.finalization.command],
    { cwd: path.join(sourceRoot, plan.project.cwd), env: { ...env, BUILDCHAIN_SIGNING_REQUEST_COUNT: request.request.count,
      BUILDCHAIN_ARTIFACT_SIGNING_STATE: request.request.count ? "signed" : "unsigned" } });
  }
  Object.assign(process.env, env);
  if (request.request.count || plan.build.finalization.command) {
    process.chdir(sourceRoot);
    runLifecycle(lifecycleOptions(plan, platform, "signing-finalization"));
  }
  verifyManifest(manifest, sourceRoot, plan, platform);
  const names = artifactNames(plan, platform);
  const finalManifest = readJson(manifest);
  finalManifest.artifactName = names.final;
  writeJson(manifest, finalManifest);
  const payload = await upload(plan, names.final, [...plan.artifacts.paths.split("\n"), `.buildchain/artifacts/${platform.id}`, ".buildchain/artifacts/signing"], sourceRoot);
  const result = { schema: "buildchain.build-signing/v1", plan_root: plan.root, platform: platform.id,
    status: "success", state: request.request.count ? "signed" : "unsigned", payload, controller: receipt };
  await publishRecord(plan, names.signing, { ...result, root: rootOf(result) }, path.join(directory, "record"));
  await cleanupRelay(plan, platform);
  output("artifact", payload);
}

export async function prepareCredential() {
  const { plan, platform } = context();
  if (platform.id !== plan.build.macos_signing.platform || !plan.build.macos_signing.app_path) throw new Error("Undeclared credential instance");
  const input = path.join(workspace, ".buildchain/credential-input");
  await downloadCredential(plan, platform, input);
  const { loadCredentialInput } = await import("../../actions/macos-credential-island/lib.js");
  const sealed = loadCredentialInput(input, { repository: plan.run.repository, sourceSha: plan.source.sha, sourceTreeSha: plan.source.tree_sha });
  const bundle = sealed.manifest.app.bundleId;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u.test(bundle)) throw new Error("Invalid sealed bundle identifier");
  output("bundle-id", bundle);
}
export async function publishCredential() {
  const { plan, platform } = context();
  verifyCredential(process.env.BUILDCHAIN_CREDENTIAL_MANIFEST, process.env.BUILDCHAIN_CREDENTIAL_ARTIFACT_ROOT, plan, platform);
  const payload = await upload(plan, `${plan.artifacts.name}-macos-credential-${plan.source.sha}`, ["."], process.env.BUILDCHAIN_CREDENTIAL_ARTIFACT_ROOT);
  const manifest = await upload(plan, `${plan.artifacts.name}-credential-manifest-macos-${plan.source.sha}`, [path.basename(process.env.BUILDCHAIN_CREDENTIAL_MANIFEST)], path.dirname(process.env.BUILDCHAIN_CREDENTIAL_MANIFEST));
  const result = { schema: "buildchain.build-credential/v1", plan_root: plan.root, platform: platform.id, payload, manifest, status: "success" };
  await publishRecord(plan, `${artifactNames(plan, platform).signing}-credential`, { ...result, root: rootOf(result) }, path.join(signingRoot(platform), "credential-record"));
  await cleanupCredentialRelay(plan, platform);
}
main(import.meta.url, () => ({ control: controlSigning, finalize: finalizeSigning, "prepare-credential": prepareCredential, "publish-credential": publishCredential }[process.argv[2]] || (() => { throw new Error("Unknown signing operation"); }))());
