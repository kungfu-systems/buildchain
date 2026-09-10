import fs from "node:fs";
import path from "node:path";
import { workflowInstallationRoot } from "../installation.js";
import {
  inspectUniversalRequest,
  admitReviewedWorkflow,
} from "./transactions.js";
import { readCandidateReview } from "./review.js";
const request = (core) =>
  JSON.parse(core.getInput("request-json", { required: true }));
export function inspectUniversalRequestAction(core) {
  const outputs = inspectUniversalRequest(
    request(core),
    core.getBooleanInput("recovery"),
  );
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
}
export function reviewUniversalCandidateAction(core, env) {
  const review = readCandidateReview({
    request: request(core),
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot: workflowInstallationRoot(import.meta.url),
    candidateRoot: path.join(env.GITHUB_WORKSPACE, ".buildchain/candidate"),
    token: core.getInput("token", { required: true }),
  });
  const file = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/review-evidence.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(review, null, 2) + "\n");
  core.setOutput("review-json", JSON.stringify(review));
}
export function admitUniversalCandidateAction(core, env) {
  const admitted = admitReviewedWorkflow({
    request: request(core),
    reviewEvidence: JSON.parse(
      core.getInput("review-json", { required: true }),
    ),
    workspace: env.GITHUB_WORKSPACE,
    candidateRoot: path.join(env.GITHUB_WORKSPACE, ".buildchain/candidate"),
    consumer: {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      workflowRef: env.GITHUB_WORKFLOW_REF,
    },
  });
  for (const [key, value] of Object.entries({
    "runtime-sha": admitted.runtime.sha,
    "request-root": admitted.requestRoot,
    "admission-root": admitted.admissionRoot,
    "admission-json": JSON.stringify(admitted),
  }))
    core.setOutput(key, value);
}
