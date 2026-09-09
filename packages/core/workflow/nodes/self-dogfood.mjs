import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runOperation, requireValue } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import {
  createUniversalSelfDogfoodRequest,
  verifyUniversalSelfDogfoodPair,
} from "../universal-self-dogfood.js";

export function selfDogfoodCoordinates(env) {
  requireValue(
    ["pull_request", "workflow_dispatch"].includes(env.EVENT_NAME),
    "Self-dogfood event must be a pull request or explicit dispatch",
  );
  const pull = env.EVENT_NAME === "pull_request";
  const candidateSha = pull
      ? env.EVENT_CANDIDATE_SHA
      : env.DISPATCH_CANDIDATE_SHA,
    consumerSha = pull ? env.EVENT_CONSUMER_SHA : env.DISPATCH_CONSUMER_SHA,
    number = pull ? env.EVENT_PULL_REQUEST : env.DISPATCH_PULL_REQUEST;
  requireValue(
    /^[0-9a-f]{40}$/.test(candidateSha || "") &&
      /^[0-9a-f]{40}$/.test(consumerSha || "") &&
      /^[1-9][0-9]*$/.test(number || ""),
    "Self-dogfood requires exact immutable candidate and consumer coordinates",
  );
  writeGitHubOutputs({
    "candidate-sha": candidateSha,
    "consumer-sha": consumerSha,
    "pull-request": number,
  });
}
export function selfDogfoodRequests(env) {
  const results = {};
  for (const channel of ["conformance", "alpha", "stable"])
    results[`${channel}-request`] = JSON.stringify(
      createUniversalSelfDogfoodRequest({
        candidateSha: env.CANDIDATE_SHA,
        consumerSha: env.CONSUMER_SHA,
        pullRequest: Number(env.REVIEW_PR),
        channel,
      }),
    );
  writeGitHubOutputs(results);
}
export function reconcileSelfDogfood(env) {
  const directory = ".buildchain/self-dogfood";
  fs.mkdirSync(directory, { recursive: true });
  const pairs = [];
  for (const channel of ["conformance", "alpha", "stable"]) {
    const result = verifyUniversalSelfDogfoodPair({
      primary: JSON.parse(env[`${channel.toUpperCase()}_PRIMARY`]),
      recovery: JSON.parse(env[`${channel.toUpperCase()}_RECOVERY`]),
      expectedSha: env.CANDIDATE_SHA,
      channel,
    });
    fs.writeFileSync(
      path.join(directory, `${channel}.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
    pairs.push(result);
  }
  const report = {
    schema: "kungfu-buildchain-v4-universal-self-dogfood/v1",
    pairs,
    equivalent:
      pairs.length === 3 && pairs.every((pair) => pair.equivalent === true),
  };
  requireValue(
    report.equivalent,
    "Self-dogfood execution pairs are not equivalent",
  );
  fs.writeFileSync(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await runOperation({
    coordinates: selfDogfoodCoordinates,
    requests: selfDogfoodRequests,
    reconcile: reconcileSelfDogfood,
  });
