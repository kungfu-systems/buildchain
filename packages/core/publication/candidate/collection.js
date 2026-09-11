import path from "node:path";
import { receiptControllerEvidence } from "../../observability/controller-evidence-io.js";
export function collectPublicationEvidence(
  {
    workspace,
    workingDirectory,
    preparePaperPackage,
    runtimeOutcomes,
    outcomes,
    uploadOutcome,
    manifestPath,
    passportPath,
    sourceSha,
  },
  record = receiptControllerEvidence,
) {
  const qualified = outcomes.manifest === "success";
  const evidenceFiles = qualified
    ? [
        {
          kind: "publication-manifest",
          path: path.resolve(workspace, workingDirectory, manifestPath),
        },
        {
          kind: "publication-passport",
          path: path.resolve(workspace, workingDirectory, passportPath),
        },
        {
          kind: "publication-reproducibility",
          path: path.resolve(
            workspace,
            workingDirectory,
            ".buildchain/publication/reproducibility-receipt.json",
          ),
        },
      ]
    : [];
  return record({
    planPath: path.join(workspace, ".buildchain/controller/plan.json"),
    outputPath: path.join(workspace, ".buildchain/controller/receipt.json"),
    stages: [
      {
        id: "resolve-runtime",
        status: runtimeOutcomes.every((value) => value === "success")
          ? "success"
          : "failure",
      },
      { id: "build", status: outcomes.build || "skipped" },
      { id: "verify", status: outcomes.verify || "skipped" },
      {
        id: "collect",
        status:
          qualified && (!preparePaperPackage || outcomes.package === "success")
            ? "success"
            : "failure",
      },
      { id: "aggregate", status: uploadOutcome },
    ],
    evidenceFiles,
    artifact: `buildchain-publication-controller-receipt-${sourceSha}`,
    ...(uploadOutcome === "success"
      ? {}
      : {
          reason: {
            code: "publication-incomplete",
            summary: "Publication artifact did not complete successfully",
          },
        }),
  });
}
