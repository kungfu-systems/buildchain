import fs from "node:fs";
import * as github from "@actions/github";
import { readSelfDogfoodReadiness } from "./readiness.js";
import {
  selfDogfoodCoordinates,
  createSelfDogfoodRequests,
  reconcileSelfDogfood,
} from "./transactions.js";
export async function admitSelfDogfoodAction(core, env) {
  const coordinates = selfDogfoodCoordinates({
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    request: JSON.parse(core.getInput("request-json", { required: true })),
    sourceSha: env.GITHUB_SHA,
  });
  const ready = await readSelfDogfoodReadiness({
    github: github.getOctokit(core.getInput("token", { required: true })),
    number: Number(coordinates["pull-request"]),
    candidateSha: coordinates["candidate-sha"],
  });
  for (const [key, value] of Object.entries({
    ...coordinates,
    ready: String(ready),
  }))
    core.setOutput(key, value);
}
export function generateSelfDogfoodRequestsAction(core) {
  const coordinates = JSON.parse(
    core.getInput("coordinates-json", { required: true }),
  );
  for (const [key, value] of Object.entries(
    createSelfDogfoodRequests(coordinates),
  ))
    core.setOutput(key, value);
}
export function reconcileSelfDogfoodAction(core, env) {
  const candidateSha = core.getInput("candidate-sha", { required: true });
  return reconcileSelfDogfood({
    workspace: env.GITHUB_WORKSPACE,
    candidateSha,
    observations: JSON.parse(
      core.getInput("observations-json", { required: true }),
    ),
  });
}
