import fs from "node:fs";
import path from "node:path";
import {
  createUniversalSelfDogfoodRequest,
  verifyUniversalSelfDogfoodPair,
} from "../universal-self-dogfood.js";
export function selfDogfoodCoordinates({
  eventName,
  event,
  request,
  sourceSha,
}) {
  if (!["pull_request", "workflow_dispatch"].includes(eventName))
    throw new Error(
      "Self-dogfood event must be a pull request or explicit dispatch",
    );
  const pull = eventName === "pull_request",
    candidateSha = pull
      ? event.pull_request?.head.sha
      : request["candidate-sha"],
    consumerSha = pull ? sourceSha : request["consumer-sha"],
    number = pull ? event.pull_request?.number : request["pull-request"];
  if (
    !/^[0-9a-f]{40}$/.test(candidateSha || "") ||
    !/^[0-9a-f]{40}$/.test(consumerSha || "") ||
    !/^[1-9][0-9]*$/.test(String(number || ""))
  )
    throw new Error(
      "Self-dogfood requires exact immutable candidate and consumer coordinates",
    );
  return {
    "candidate-sha": candidateSha,
    "consumer-sha": consumerSha,
    "pull-request": String(number),
  };
}
export function createSelfDogfoodRequests(coordinates) {
  return Object.fromEntries(
    ["conformance", "alpha", "stable"].map((channel) => [
      `${channel}-request`,
      JSON.stringify(
        createUniversalSelfDogfoodRequest({
          candidateSha: coordinates["candidate-sha"],
          consumerSha: coordinates["consumer-sha"],
          pullRequest: Number(coordinates["pull-request"]),
          channel,
        }),
      ),
    ]),
  );
}
export function reconcileSelfDogfood({
  workspace,
  candidateSha,
  observations,
}) {
  const directory = path.join(workspace, ".buildchain/self-dogfood");
  fs.mkdirSync(directory, { recursive: true });
  const pairs = [];
  for (const channel of ["conformance", "alpha", "stable"]) {
    const result = verifyUniversalSelfDogfoodPair({
      primary: JSON.parse(
        observations[`primary-${channel}`].outputs["result-json"],
      ),
      recovery: JSON.parse(
        observations[`recovery-${channel}`].outputs["result-json"],
      ),
      expectedSha: candidateSha,
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
  fs.writeFileSync(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (!report.equivalent)
    throw new Error("Self-dogfood execution pairs are not equivalent");
  return report;
}
