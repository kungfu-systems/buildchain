import fs from "node:fs";
import { getOctokit } from "@actions/github";
import { repositoryActorPermission } from "../providers/github-permission.js";
import { resolveWebSurfaceProductionDecision } from "./production-decision.js";

export async function webProductionDecisionAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true })),
    intent = JSON.parse(core.getInput("intent-json", { required: true }));
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  let permission = "";
  if (
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    request["production-apply"] === true
  )
    permission = await repositoryActorPermission(
      { owner, repo, actor: env.GITHUB_ACTOR },
      getOctokit(core.getInput("token", { required: true })),
    );
  const decision = resolveWebSurfaceProductionDecision({
    eventName: env.GITHUB_EVENT_NAME,
    eventAction: event.action,
    refName: env.GITHUB_REF_NAME,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: intent["production-source-sha"] || env.GITHUB_SHA,
    actor: env.GITHUB_ACTOR,
    productionApply: request["production-apply"],
    productionApproved: request["production-approved"],
    productionReleaseOnMain: request["production-release-on-main"],
    actorPermission: permission,
    releaseApproved: intent["production-release-approved"] === "true",
    releasePr: Number(intent["production-release-pr"] || 0),
    releaseSource: intent["production-release-source"],
  });
  core.setOutput("approved", String(decision.approved));
  core.setOutput("decision-json", JSON.stringify(decision));
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Web production decision\n\n- approved: \`${decision.approved}\`\n- kind: \`${decision.kind}\`\n- reason: \`${decision.reason}\`\n`,
    );
}
