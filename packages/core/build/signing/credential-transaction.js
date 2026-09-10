import path from "node:path";
import { artifactNames, verifyCredential } from "../artifact/contracts.js";
import { rootOf } from "../plan/values.js";
export async function prepareCredential(context) {
  const { plan, platform, workspace, services } = context;
  const { downloadCredential } = services;
  if (
    platform.id !== plan.build.macos_signing.platform ||
    !plan.build.macos_signing.app_path
  )
    throw new Error("Undeclared credential instance");
  const input = path.join(workspace, ".buildchain/credential-input");
  await downloadCredential(platform, input);
  const { loadCredentialInput } =
    await import("../macos-credential-island/lib.js");
  const sealed = loadCredentialInput(input, {
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    sourceTreeSha: plan.source.tree_sha,
  });
  const bundle = sealed.manifest.app.bundleId;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u.test(bundle))
    throw new Error("Invalid sealed bundle identifier");
  return { bundleId: bundle };
}

export async function publishCredential(
  context,
  { manifestPath, artifactRoot },
) {
  const { plan, platform, workspace, services } = context;
  const {
    store: { publishRecord, upload },
    cleanupCredentialRelay,
  } = services;
  const signingRoot = (platform) =>
    path.join(workspace, `.buildchain/signing/${platform.id}`);
  verifyCredential(manifestPath, artifactRoot, plan, platform);
  const payload = await upload(
    plan,
    `${plan.artifacts.name}-macos-credential-${plan.source.sha}`,
    ["."],
    artifactRoot,
  );
  const manifest = await upload(
    plan,
    `${plan.artifacts.name}-credential-manifest-macos-${plan.source.sha}`,
    [path.basename(manifestPath)],
    path.dirname(manifestPath),
  );
  const result = {
    schema: "buildchain.build-credential/v1",
    plan_root: plan.root,
    platform: platform.id,
    payload,
    manifest,
    status: "success",
  };
  await publishRecord(
    plan,
    `${artifactNames(plan, platform).signing}-credential`,
    { ...result, root: rootOf(result) },
    path.join(signingRoot(platform), "credential-record"),
  );
  await cleanupCredentialRelay(platform);
}
