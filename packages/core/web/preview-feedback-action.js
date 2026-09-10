import fs from "node:fs";
import path from "node:path";
import { commentPreviewResult } from "./preview-feedback.js";

export async function previewFeedbackAction(core, env) {
  const cleanup = core.getBooleanInput("cleanup");
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  if (
    !Number.isInteger(event.pull_request?.number) ||
    event.pull_request.number < 1
  )
    throw new Error("Preview feedback requires a pull request event");
  const file = path.join(
    env.GITHUB_WORKSPACE,
    `.buildchain/web-surface-${cleanup ? "cleanup" : "preview"}-apply.json`,
  );
  return commentPreviewResult({
    result: JSON.parse(fs.readFileSync(file, "utf8")),
    cleanup,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    repository: env.GITHUB_REPOSITORY,
    pullNumber: event.pull_request.number,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
  });
}
