import { collectPublicationEvidence } from "./collection.js";
export function collectPublicationEvidenceAction(core, env) {
  const input = JSON.parse(core.getInput("request-json", { required: true }));
  const receipt = collectPublicationEvidence({
    workspace: env.GITHUB_WORKSPACE,
    workingDirectory: input["working-directory"] || ".",
    preparePaperPackage: input["prepare-paper-package"] === true,
    runtimeOutcomes: JSON.parse(
      core.getInput("runtime-outcomes-json", { required: true }),
    ),
    outcomes: JSON.parse(core.getInput("outcomes-json") || "{}"),
    uploadOutcome: core.getInput("upload-outcome", { required: true }),
    manifestPath: core.getInput("manifest-path"),
    passportPath: core.getInput("passport-path"),
    sourceSha: core.getInput("source-sha", { required: true }),
  });
  for (const [key, value] of Object.entries({
    "controller-receipt-json": JSON.stringify(receipt),
    "controller-receipt-digest": receipt.digest,
    "controller-receipt-status": receipt.status,
    "controller-receipt-qualifying": String(receipt.qualifying),
  }))
    core.setOutput(key, value);
}
