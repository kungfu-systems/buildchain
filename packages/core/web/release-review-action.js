import fs from "node:fs";
import path from "node:path";
import { reviewWebRelease } from "./release-review.js";

export function webReleaseReviewAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  return reviewWebRelease({
    request,
    workingDirectory: path.resolve(
      env.GITHUB_WORKSPACE,
      request["working-directory"],
    ),
    token: core.getInput("token"),
    event: {
      name: env.GITHUB_EVENT_NAME,
      payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
      repository: env.GITHUB_REPOSITORY,
      apiUrl: env.GITHUB_API_URL,
    },
  });
}
