import fs from "node:fs";
import * as github from "@actions/github";
import { installationRoot } from "../../runtime/installation-root.js";
import { command } from "../../runtime/action-process.mjs";
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
function exactCandidate(sha) {
  if (
    !/^[0-9a-f]{40}$/.test(sha || "") ||
    command(
      "git",
      ["-C", installationRoot(import.meta.url), "rev-parse", "HEAD"],
      { stdio: "pipe" },
    ).trim() !== sha
  )
    throw new Error(
      "Self-dogfood must execute the exact independently reviewed candidate",
    );
}
export function generateSelfDogfoodRequestsAction(core) {
  const coordinates = JSON.parse(
    core.getInput("coordinates-json", { required: true }),
  );
  exactCandidate(coordinates["candidate-sha"]);
  for (const [key, value] of Object.entries(
    createSelfDogfoodRequests(coordinates),
  ))
    core.setOutput(key, value);
}
export function reconcileSelfDogfoodAction(core, env) {
  const candidateSha = core.getInput("candidate-sha", { required: true });
  exactCandidate(candidateSha);
  return reconcileSelfDogfood({
    workspace: env.GITHUB_WORKSPACE,
    candidateSha,
    observations: JSON.parse(
      core.getInput("observations-json", { required: true }),
    ),
  });
}
