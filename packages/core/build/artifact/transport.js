import {
  downloadCredential,
  cleanupCredentialRelay,
} from "./credential-transport.js";
import { transferBuild } from "./upload.js";
import fs from "node:fs";
import path from "node:path";
import {
  downloadRelayArtifacts,
  cleanupRelayArtifacts,
} from "../../providers/artifact-relay/transactions.js";
import {
  artifactNames,
  verifyExecution,
  verifyManifest,
  validateReference,
} from "./contracts.js";
import { readJson } from "../plan/values.js";
async function downloadBuild(
  context,
  platform,
  target,
  { payload = true } = {},
) {
  const { plan, workspace, store, relay } = context;
  const { download, readRecord } = store;
  const names = artifactNames(plan, platform);
  const execution = verifyExecution(
    await readRecord(
      plan,
      names.execution,
      path.join(workspace, `.buildchain/records/${platform.id}`),
    ),
    plan,
    platform,
  );
  const get = (role) => {
    const matches = execution.artifacts.filter((entry) => entry.role === role);
    if (matches.length !== 1)
      throw new Error(`Missing unique ${platform.id} ${role} artifact`);
    return validateReference(
      matches[0].ref,
      plan,
      role === "credential" ? names.credentialInput : names[role],
    );
  };
  if (!payload) return { execution, get };
  if (execution.artifacts.some((entry) => entry.role === "relay")) {
    const inputRoot = path.join(workspace, `.buildchain/relay/${platform.id}`);
    await download(get("relay"), inputRoot);
    const manifest = readJson(path.join(inputRoot, "relay-manifest.json"));
    if (
      manifest.repository !== plan.run.repository ||
      String(manifest.runId) !== plan.run.id ||
      String(manifest.runAttempt) !== plan.run.attempt ||
      manifest.sourceSha !== plan.source.sha ||
      manifest.platform?.id !== platform.id ||
      manifest.s3?.bucket !== plan.transfer.s3Bucket
    )
      throw new Error("Relay identity mismatch");
    const parent = path.join(
      workspace,
      `.buildchain/relay-download/${platform.id}`,
    );
    await downloadRelayArtifacts({
      client: relay,
      inputRoot,
      outputRoot: parent,
      region: plan.transfer.s3Region,
      platformId: platform.id,
    });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(parent, "payload"), target, { recursive: true });
  } else await download(get("payload"), target);
  verifyManifest(
    path.join(target, `.buildchain/artifacts/${platform.id}/manifest.json`),
    target,
    plan,
    platform,
  );
  return { execution, get };
}
async function cleanupRelay(context, platform) {
  const { plan, workspace, relay } = context;
  if (plan.transfer.mode !== "s3-to-github-artifacts" || platform.githubHosted)
    return;
  await cleanupRelayArtifacts({
    client: relay,
    inputRoot: path.join(workspace, `.buildchain/relay/${platform.id}`),
    region: plan.transfer.s3Region,
    platformId: platform.id,
  });
}
export function createBuildArtifactTransport({
  plan,
  workspace,
  sourceRoot,
  store,
  relay,
}) {
  const context = { plan, workspace, sourceRoot, store, relay };
  return {
    transferBuild: (platform) => transferBuild(context, platform),
    downloadBuild: (platform, target, options) =>
      downloadBuild(context, platform, target, options),
    cleanupRelay: (platform) => cleanupRelay(context, platform),
    downloadCredential: (platform, target) =>
      downloadCredential(context, downloadBuild, platform, target),
    cleanupCredentialRelay: (platform) =>
      cleanupCredentialRelay(context, platform),
  };
}
