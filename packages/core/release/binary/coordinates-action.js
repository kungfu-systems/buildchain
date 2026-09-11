import { getOctokit } from "@actions/github";
import { resolveBinaryPublicationCoordinates } from "./coordinates.js";
export async function resolveBinaryPublicationAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const values = await resolveBinaryPublicationCoordinates({
    repository: env.GITHUB_REPOSITORY,
    runId: request["evidence-run-id"],
    tag: request["release-tag"],
    github: getOctokit(core.getInput("token", { required: true })),
  });
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
}
