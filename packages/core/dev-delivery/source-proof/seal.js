import { createReusableSourceQualificationProof } from "../dev-delivery-warrant.js";
import { validateControllerReceipt } from "../../observability/controller-evidence.js";
import { sourceQualificationPredicates } from "./predicates.js";
import { readJson, exactSha, required } from "./io.js";
export function sealSourceQualificationProof(input = {}) {
  const receipt = readJson(input.controllerReceiptPath, "controller receipt");
  const expectedSourceSha = exactSha(input.sourceHead, "sourceHead");
  const expectedRepository = required(input.repository, "repository");
  const validation = validateControllerReceipt(receipt, {
    expectedSourceSha,
  });
  if (
    !validation.ok ||
    !validation.qualifying ||
    receipt.controller?.id !== "source-check" ||
    receipt.source?.repository !== expectedRepository
  ) {
    throw new Error(
      `controller receipt is not qualifying: ${validation.issues.join("; ") || receipt.status || "unknown"}`,
    );
  }
  const predicates = sourceQualificationPredicates(input);
  return createReusableSourceQualificationProof({
    ...predicates,
    controllerReceiptRoot: receipt.digest,
    sourceWorkflowRunId: input.sourceWorkflowRunId,
    shardEvidenceRoots: [receipt.digest],
    qualifiedAt: input.qualifiedAt,
  });
}
