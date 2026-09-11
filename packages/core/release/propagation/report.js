import path from "node:path";
import { receiptControllerEvidence } from "../../observability/controller-evidence-io.js";
import { readPropagation, propagationPaths } from "./store.js";
import { propagationJournal } from "./transactions.js";

function observedStatus(journal, observations, id) {
  const value = journal.stages[id]?.status || "skipped";
  return value === "running"
    ? observations.cancelled
      ? "cancelled"
      : "failure"
    : value;
}
export function propagationControllerStages(journal, observations) {
  const status = (id) => observedStatus(journal, observations, id);
  const combined = (values, optional = false) => {
    if (values.includes("failure")) return "failure";
    if (values.includes("cancelled")) return "cancelled";
    if (
      optional
        ? values.includes("success")
        : values.every((value) => value === "success")
    )
      return "success";
    return "skipped";
  };
  return [
    ["resolve-runtime", status("resolve-runtime")],
    ["plan", status("plan")],
    ["emit-work", status("emit-work")],
    ["write-lock", status("write-lock")],
    [
      "prepare-consumer",
      combined([status("downstream-update"), status("prepare")], true),
    ],
    ["refresh-badges", status("refresh-badges")],
    ["verify-consumer", status("verify-consumer")],
    ["open-pr", status("open-pr")],
    [
      "aggregate",
      combined([
        status("summary"),
        status("receipt"),
        status("record-materialization"),
        observations.upload,
        observations.reconcile,
        status("work-output"),
        observations.workUpload,
      ]),
    ],
  ].map(([id, value]) => ({ id, status: value }));
}

export function propagationControllerReport(context, observations) {
  const { workspace, root } = propagationPaths(context);
  const journal = propagationJournal(context);
  const stages = propagationControllerStages(journal, observations);
  const status = (id) => observedStatus(journal, observations, id);
  const complete =
    ["plan", "write-lock", "record-materialization", "receipt"].every(
      (id) => status(id) === "success",
    ) &&
    ["downstream-update", "prepare", "refresh-badges", "verify-consumer"].every(
      (id) => !["failure", "cancelled"].includes(status(id)),
    );
  const files = complete
    ? [
        { kind: "propagation-plan", path: path.join(root, "plan.json") },
        { kind: "propagation-lock", path: path.join(root, "write-lock.json") },
        ...(context.request["dry-run"]
          ? []
          : [
              {
                kind: "propagation-branch-reconciliation",
                path: path.join(root, "branch-reconciliation.json"),
              },
            ]),
      ]
    : [];
  const receipt = receiptControllerEvidence({
    planPath: path.join(workspace, ".buildchain/controller/plan.json"),
    outputPath: path.join(workspace, ".buildchain/controller/receipt.json"),
    stages,
    evidenceFiles: files,
    artifact: `buildchain-release-propagation-controller-receipt-${context.source.sha}`,
    reason: complete
      ? undefined
      : {
          code: "propagation-incomplete",
          summary: "Release propagation did not complete successfully",
        },
  });
  const captureOnly =
    status("emit-work") === "success" &&
    readPropagation("work.json", context).authority.mode !== "execute";
  return { receipt, accepted: captureOnly || receipt.qualifying };
}
