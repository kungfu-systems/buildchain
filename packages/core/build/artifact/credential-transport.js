import fs from "node:fs";
import path from "node:path";
import {
  downloadRelayArtifacts,
  cleanupRelayArtifacts,
} from "../../providers/artifact-relay/transactions.js";
import { readJson } from "../plan/values.js";
export async function downloadCredential(
  context,
  downloadBuild,
  platform,
  target,
) {
  const { plan, workspace, store, relay } = context;
  const { download } = store;
  const { execution, get } = await downloadBuild(context, platform, "", {
    payload: false,
  });
  if (!execution.artifacts.some((entry) => entry.role === "credentialRelay"))
    return download(get("credential"), target);
  const inputRoot = path.join(
    workspace,
    `.buildchain/credential-relay/${platform.id}`,
  );
  await download(get("credentialRelay"), inputRoot);
  const manifest = readJson(path.join(inputRoot, "relay-manifest.json"));
  if (
    manifest.repository !== plan.run.repository ||
    String(manifest.runId) !== plan.run.id ||
    String(manifest.runAttempt) !== plan.run.attempt ||
    manifest.sourceSha !== plan.source.sha ||
    manifest.platform?.id !== platform.id ||
    manifest.s3?.bucket !== plan.transfer.s3Bucket ||
    manifest.groups?.length !== 1 ||
    manifest.groups[0].role !== "credential-input"
  )
    throw new Error("Credential relay identity mismatch");
  const parent = path.join(
    workspace,
    `.buildchain/credential-download/${platform.id}`,
  );
  await downloadRelayArtifacts({
    client: relay,
    inputRoot,
    outputRoot: parent,
    region: plan.transfer.s3Region,
    platformId: platform.id,
  });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(parent, "credential-input"), target, {
    recursive: true,
  });
}

export async function cleanupCredentialRelay(context, platform) {
  const { plan, workspace, relay } = context;
  if (plan.transfer.mode !== "s3-to-github-artifacts" || platform.githubHosted)
    return;
  await cleanupRelayArtifacts({
    client: relay,
    inputRoot: path.join(
      workspace,
      `.buildchain/credential-relay/${platform.id}`,
    ),
    region: plan.transfer.s3Region,
    platformId: platform.id,
  });
}
