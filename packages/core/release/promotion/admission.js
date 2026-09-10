import path from "node:path";
import { authorizePromotionRuntimeOverride } from "../runtime-override-authorization.js";
import { bindPromotionInvocation } from "../promotion-request.js";
export async function admitPromotionInvocation({
  request,
  selection,
  workspace,
  consumerPolicyRoot,
  github,
  context,
}) {
  let authorization = {};
  if (selection["override-used"] === "true") {
    const root = path.join(workspace, ".buildchain/consumer"),
      mode = request["resume-candidate-run-id"] ? "resume" : "dispatch";
    const result = await authorizePromotionRuntimeOverride({
      github,
      context,
      request: {
        consumerRoot: root,
        runtimeRepository: request["buildchain-repository"],
        consumerPolicyReceiptPath: path.join(
          root,
          ".buildchain/evidence/consumer-policy-receipt.json",
        ),
        consumerPolicyReceiptRoot: consumerPolicyRoot,
        sourceSha: request["target-sha"] || context.sha,
        requestedRef: selection["runtime-ref"],
        resolvedRuntimeSha: selection["runtime-sha"],
        reason: `trusted ${mode} runtime override ${selection["runtime-ref"]} for source ${request["target-sha"] || context.sha}`,
        mode,
        outputPath: path.join(
          root,
          ".buildchain/evidence/runtime-authorization.json",
        ),
      },
    });
    authorization = {
      "runtime-authorization-json": JSON.stringify({
        receipt: result.receipt,
        receiptRoot: result.receiptRoot,
      }),
      "runtime-authorization-root": result.receiptRoot,
    };
  }
  return {
    ...authorization,
    "invocation-json": JSON.stringify(
      bindPromotionInvocation(request, selection, authorization),
    ),
  };
}
