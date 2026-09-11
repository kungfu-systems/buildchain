import { writeJson } from "../plan/values.js";
import { buildControllerStages } from "./execution.js";
import { receiptControllerEvidence } from "../../observability/controller-evidence-io.js";
export async function controllerReceipt(
  { file, upload },
  plan,
  jobs,
  success,
  executions = [],
) {
  writeJson(file(".buildchain/controller/plan.json"), plan.controller);
  const stages = buildControllerStages(plan, jobs, executions, success);
  const receipt = receiptControllerEvidence({
    planPath: file(".buildchain/controller/plan.json"),
    outputPath: file(".buildchain/controller/receipt.json"),
    stages,
    evidenceFiles: success
      ? [
          {
            kind: "anchored-version-material",
            path: file(".buildchain/controller/anchored-version-material.json"),
          },
          {
            kind: "platform-manifests",
            path: file(".buildchain/artifacts/build-summary.json"),
          },
          {
            kind: "build-summary",
            path: file(".buildchain/artifacts/build-summary.json"),
          },
        ]
      : [],
    reason: success
      ? undefined
      : {
          code: "controller-incomplete",
          summary: "Build did not complete successfully",
        },
    artifact: `${plan.artifacts.name}-controller-receipt-${plan.source.sha}`,
  });
  return {
    receipt,
    artifact: await upload(
      plan,
      `${plan.artifacts.name}-controller-receipt-${plan.source.sha}`,
      ["receipt.json"],
      file(".buildchain/controller"),
    ),
  };
}
