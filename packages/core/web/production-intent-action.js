import { context, getOctokit } from "@actions/github";
import { resolveReleaseIntent } from "./production-intent.js";

export async function productionIntentAction(core) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Web release intent requires a typed request object");
  return resolveReleaseIntent({
    request,
    core,
    context,
    github: getOctokit(core.getInput("token", { required: true })),
  });
}
