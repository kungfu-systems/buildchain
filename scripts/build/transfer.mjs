import fs from "node:fs";
import path from "node:path";
import { uploadRelayArtifacts, downloadRelayArtifacts, cleanupRelayArtifacts } from "../artifact-relay-s3.mjs";
import { artifactNames, executionResult, verifyExecution, verifyManifest } from "./artifact-contract.mjs";
import { context, main, output, readJson, sourceRoot, workspace } from "./context.mjs";
import { download, upload, publishRecord, readRecord, validateReference } from "./artifact-store.mjs";

export async function transferBuild() {
  const { plan, platform } = context();
  const names = artifactNames(plan, platform);
  const executionFile = path.join(sourceRoot, `.buildchain/execution/${platform.id}.json`);
  const execution = fs.existsSync(executionFile) ? readJson(executionFile) : executionResult(plan, platform, {});
  const artifacts = [];
  const qualified = ["success", "not-required"].includes(execution.stages.verify);
  if (qualified) {
    verifyExecution(execution, plan, platform);
    const paths = [...plan.artifacts.paths.split("\n"), `.buildchain/artifacts/${platform.id}`, ".buildchain/artifacts/signing"];
    verifyManifest(path.join(sourceRoot, `.buildchain/artifacts/${platform.id}/manifest.json`), sourceRoot, plan, platform);
    if (plan.transfer.mode === "s3-to-github-artifacts" && !platform.githubHosted) {
      const file = `.buildchain/relay/${platform.id}/relay-manifest.json`;
      await uploadRelayArtifacts({ workspace: sourceRoot, manifestPath: file, bucket: plan.transfer.s3Bucket,
        region: plan.transfer.s3Region, prefix: plan.transfer.s3Prefix, repository: plan.run.repository,
        runId: plan.run.id, runAttempt: plan.run.attempt, sourceSha: plan.source.sha, platformId: platform.id, platformName: platform.name,
        groups: [{ role: "payload", artifactName: names.payload, paths }] });
      artifacts.push({ role: "relay", ref: await upload(plan, names.relay, ["relay-manifest.json"], path.dirname(path.join(sourceRoot, file))) });
    } else artifacts.push({ role: "payload", ref: await upload(plan, names.payload, paths, sourceRoot) });
    const requestRoot = path.join(sourceRoot, `.buildchain/signing/requests/${platform.id}`);
    const index = readJson(path.join(requestRoot, "index.json"));
    if (index.requests.length) artifacts.push({ role: "request", ref: await upload(plan, names.request, ["."], requestRoot) });
    artifacts.push({ role: "control", ref: await upload(plan, names.control, ["request.json"], path.join(sourceRoot, `.buildchain/signing/control-requests/${platform.id}`)) });
    if (plan.build.macos_signing.app_path && plan.build.macos_signing.platform === platform.id) {
      const credentialRoot = path.join(sourceRoot, `.buildchain/credential-island/${platform.id}`);
      if (plan.transfer.mode === "s3-to-github-artifacts" && !platform.githubHosted) {
        const file = path.join(workspace, `.buildchain/credential-relay/${platform.id}/relay-manifest.json`);
        await uploadRelayArtifacts({ workspace: credentialRoot, manifestPath: file, bucket: plan.transfer.s3Bucket,
          region: plan.transfer.s3Region, prefix: plan.transfer.s3Prefix, repository: plan.run.repository,
          runId: plan.run.id, runAttempt: plan.run.attempt, sourceSha: plan.source.sha, platformId: platform.id, platformName: platform.name,
          groups: [{ role: "credential-input", artifactName: names.credentialInput, paths: ["."] }] });
        artifacts.push({ role: "credentialRelay", ref: await upload(plan, names.credentialRelay, ["relay-manifest.json"], path.dirname(file)) });
      } else artifacts.push({ role: "credential", ref: await upload(plan, names.credentialInput, ["."], credentialRoot) });
    }
  }
  const evidence = await upload(plan, names.diagnostics, [`.buildchain/artifacts/${platform.id}`, ".buildchain/diagnostics", ".buildchain/logs",
    ...(plan.build.verification.substage_evidence_path ? [path.posix.join(plan.project.cwd, plan.build.verification.substage_evidence_path)] : [])], sourceRoot, { allowEmpty: true });
  if (evidence) artifacts.push({ role: "diagnostics", ref: evidence });
  const result = executionResult(plan, platform, execution.stages, artifacts);
  output("artifact", await publishRecord(plan, names.execution, result, path.join(workspace, `.buildchain/records/${platform.id}`)));
}

export async function downloadBuild(plan, platform, target, { payload = true } = {}) {
  const names = artifactNames(plan, platform);
  const execution = verifyExecution(await readRecord(plan, names.execution, path.join(workspace, `.buildchain/records/${platform.id}`)), plan, platform);
  const get = (role) => {
    const matches = execution.artifacts.filter((entry) => entry.role === role);
    if (matches.length !== 1) throw new Error(`Missing unique ${platform.id} ${role} artifact`);
    return validateReference(matches[0].ref, plan, role === "credential" ? names.credentialInput : names[role]);
  };
  if (!payload) return { execution, get };
  if (execution.artifacts.some((entry) => entry.role === "relay")) {
    const inputRoot = path.join(workspace, `.buildchain/relay/${platform.id}`);
    await download(get("relay"), inputRoot);
    const manifest = readJson(path.join(inputRoot, "relay-manifest.json"));
    if (manifest.repository !== plan.run.repository || String(manifest.runId) !== plan.run.id || String(manifest.runAttempt) !== plan.run.attempt ||
        manifest.sourceSha !== plan.source.sha || manifest.platform?.id !== platform.id || manifest.s3?.bucket !== plan.transfer.s3Bucket) throw new Error("Relay identity mismatch");
    const parent = path.join(workspace, `.buildchain/relay-download/${platform.id}`);
    await downloadRelayArtifacts({ inputRoot, outputRoot: parent, region: plan.transfer.s3Region, platformId: platform.id });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(parent, "payload"), target, { recursive: true });
  } else await download(get("payload"), target);
  verifyManifest(path.join(target, `.buildchain/artifacts/${platform.id}/manifest.json`), target, plan, platform);
  return { execution, get };
}
export async function cleanupRelay(plan, platform) {
  if (plan.transfer.mode !== "s3-to-github-artifacts" || platform.githubHosted) return;
  await cleanupRelayArtifacts({ inputRoot: path.join(workspace, `.buildchain/relay/${platform.id}`), region: plan.transfer.s3Region, platformId: platform.id });
}
main(import.meta.url, transferBuild);

export async function downloadCredential(plan, platform, target) {
  const { execution, get } = await downloadBuild(plan, platform, "", { payload: false });
  if (!execution.artifacts.some((entry) => entry.role === "credentialRelay")) return download(get("credential"), target);
  const inputRoot = path.join(workspace, `.buildchain/credential-relay/${platform.id}`);
  await download(get("credentialRelay"), inputRoot);
  const manifest = readJson(path.join(inputRoot, "relay-manifest.json"));
  if (manifest.repository !== plan.run.repository || String(manifest.runId) !== plan.run.id || String(manifest.runAttempt) !== plan.run.attempt ||
      manifest.sourceSha !== plan.source.sha || manifest.platform?.id !== platform.id || manifest.s3?.bucket !== plan.transfer.s3Bucket ||
      manifest.groups?.length !== 1 || manifest.groups[0].role !== "credential-input") throw new Error("Credential relay identity mismatch");
  const parent = path.join(workspace, `.buildchain/credential-download/${platform.id}`);
  await downloadRelayArtifacts({ inputRoot, outputRoot: parent, region: plan.transfer.s3Region, platformId: platform.id });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(parent, "credential-input"), target, { recursive: true });
}
export async function cleanupCredentialRelay(plan, platform) {
  if (plan.transfer.mode !== "s3-to-github-artifacts" || platform.githubHosted) return;
  await cleanupRelayArtifacts({ inputRoot: path.join(workspace, `.buildchain/credential-relay/${platform.id}`), region: plan.transfer.s3Region, platformId: platform.id });
}
