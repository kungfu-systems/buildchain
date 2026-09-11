import path from "node:path";
import { createResolvedReleaseManifest } from "../../release/source/manifest.js";
import { resolvePublishSourceLock } from "../../release/source/coordinates.js";
import { verifyPublishChannelSource } from "../../release/source/channel.js";
import { writeJson } from "./values.js";

export async function resolveBuildReleaseSource(
  { plan, sourceRoot, workspace, source },
  channelProvider,
) {
  const refName = String(source.refName || "").replace(
    /^refs\/(?:heads|tags)\//u,
    "",
  );
  const lock = resolvePublishSourceLock({
    publishSourceRef: refName.startsWith("publish-gate/") ? refName : "",
    publishSourceSha: plan.source.sha,
    fallbackRef: source.refName || source.ref,
    fallbackSha: source.sha,
  });
  await verifyPublishChannelSource(
    {
      sourceRef: lock.sourceRef,
      sourceSha: plan.source.sha,
      repository: plan.run.repository,
    },
    channelProvider,
  );
  const manifest = await createResolvedReleaseManifest({
    cwd: path.join(sourceRoot, plan.project.cwd),
    repository: plan.run.repository,
    sourceRef: lock.sourceLocked ? lock.sourceRef : "",
    sourceSha: lock.sourceSha,
  });
  writeJson(
    path.join(workspace, ".buildchain/plan/publish-source-manifest.json"),
    manifest,
  );
  const line = lock.line;
  const target =
    source.baseRef ||
    (/^v\d+\/v\d+\.\d+$/u.test(line)
      ? `release/${line}`
      : /^v(\d+)\.(\d+)$/u.test(line)
        ? `release/v${line.slice(1).split(".")[0]}/${line}`
        : "");
  return {
    release: {
      ref: lock.sourceRef,
      channel: lock.channel,
      line,
      version: lock.consumerVersion,
      locked: lock.sourceLocked,
      manifest,
    },
    anchoredMaterial: { target_channel: lock.channel, target_ref: target },
  };
}
