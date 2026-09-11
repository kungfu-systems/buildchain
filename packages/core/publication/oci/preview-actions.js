import fs from "node:fs";
import path from "node:path";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import { admitComposePreview } from "./preview-admission.js";
import { applyComposePreview } from "./preview-transaction.js";
import { createComposePreviewRegistry } from "./preview-registry.js";
function inputs(core, env) {

  return {
    request: {
      workspace: path.resolve(env.GITHUB_WORKSPACE),
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    },
    provider: releaseAssetClient(env.GITHUB_REPOSITORY, {
      token: core.getInput("token", { required: true }),
    }),
  };
}
export async function admitComposePreviewAction(core, env) {
  const { request, provider } = inputs(core, env);
  const admitted = await admitComposePreview(request, provider);
  for (const [key, value] of Object.entries({
    "artifact-id": admitted.artifactId,
    "run-id": admitted.runId,
    "source-sha": admitted.sourceSha,
  }))
    core.setOutput(key, value);
}
export async function applyComposePreviewAction(core, env) {
  const { request, provider } = inputs(core, env);
  const { registry } = createComposePreviewRegistry({
    token: core.getInput("registry-token", { required: true }),
    actor: env.GITHUB_ACTOR,
  });
  const result = await applyComposePreview(request, { provider, registry });
  core.info(`Verified ${result.alias}@${result.observedDigest}`);
}
