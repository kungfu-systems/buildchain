import path from "node:path";
import { verifyPromotionInvocation } from "../promotion-request.js";
import { qualifyHistoricalEvidence } from "./historical-evidence.js";
export function historicalEvidenceAction(core, env) {
  const request = verifyPromotionInvocation(
    core.getInput("request-json", { required: true }),
  );
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const receipt = qualifyHistoricalEvidence({
    context: request["historical-inputs-json"],
    sourceDirectory: path.join(workspace, ".buildchain/historical-source"),
    candidateDirectory: path.join(workspace, ".buildchain/release-candidate"),
    sourceSha: core.getInput("source-sha", { required: true }),
    environment: env,
  });
  if (receipt) core.setOutput("receipt-root", receipt.receiptRoot);
}
