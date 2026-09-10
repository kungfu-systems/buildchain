import path from "node:path";
import { readJson, writeJson } from "../native/files.js";
import { createDeliveryWarrantService } from "../warrant/service.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import {
  verifyReservationReadback,
  reservationOutputs,
} from "../warrant/reservation-readback.js";
import { dispatchDeliveryHandoff } from "../warrant/handoff.js";
import { resolveCandidateAffectedPaths } from "./evidence.js";
import { deliverySubmissionRequest } from "./submission.js";
import { jsonList } from "../warrant/values.js";
export async function reserveDeliveryCandidate(
  {
    workspace,
    input,
    connection,
    branch,
    sourceProofRoot,
    qualificationOutcome,
    proofOutcome,
    predecessorsOk,
  },
  dependencies = {},
) {
  if (input["delivery-warrant-mode"] === "off")
    return { "warrant-outcome": "skipped" };
  if (qualificationOutcome !== "success")
    throw new Error(
      "Exact source qualification failed before Warrant scheduling",
    );
  if (!predecessorsOk || proofOutcome !== "success")
    throw new Error("Delivery candidate submission failed");
  const service =
    dependencies.service ||
    createDeliveryWarrantService({ ...connection, branch });
  const affectedPaths = resolveCandidateAffectedPaths({
    affectedPaths: jsonList(input["affected-paths-json"], "Affected paths"),
    sourceProofRoot,
    source: {
      repository: connection.repository,
      protectedBase: branch,
      sourceHead: input["expected-head-sha"],
      sourceIdentityRoot: input["source-identity-root"],
    },
    readProof: () =>
      readJson(
        path.join(workspace, ".buildchain/dev-delivery/source-proof.json"),
        "source proof",
      ),
  });
  const submission = await service.submit(
    deliverySubmissionRequest(input, {
      repository: connection.repository,
      branch,
      sourceProofRoot,
      affectedPaths,
    }),
  );
  writeJson(
    path.join(workspace, ".buildchain/dev-delivery/submission.json"),
    submission,
  );
  if (input["delivery-warrant-mode"] !== "required")
    return { "warrant-outcome": "skipped" };
  const result = await service.select({
    leaseSeconds: Number(input["warrant-lease-seconds"] || 3600),
    execute: true,
  });
  writeJson(
    path.join(workspace, ".buildchain/dev-delivery/warrant.json"),
    result,
  );
  const warrant = verifyReservationReadback(result);
  let outputs;
  if (
    warrant.pullRequestNumber !== Number(input["expected-pr-number"]) ||
    warrant.sourceHead !== input["expected-head-sha"]
  ) {
    outputs = await dispatchDeliveryHandoff(
      {
        warrant,
        result,
        workspace,
        repository: connection.repository,
        branch,
        workflowId: input["handoff-workflow-id"],
        heartbeatSeconds: input["native-heartbeat-seconds"],
        requested: {
          pullRequestNumber: Number(input["expected-pr-number"]),
          sourceHead: input["expected-head-sha"],
        },
      },
      dependencies.provider || new GitHubTwoPhaseClient(connection),
    );
  } else outputs = reservationOutputs(result, warrant);
  return { ...outputs, "warrant-outcome": "success" };
}
