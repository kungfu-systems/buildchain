import { runOperation } from "../../runtime/action-process.mjs";
import { verifyPromotionInvocation } from "../promotion-request.js";

await runOperation({ verify: (env) => verifyPromotionInvocation(
  env.BUILDCHAIN_PROMOTION_REQUEST_JSON,
  JSON.parse(env.BUILDCHAIN_WORKFLOW_SHA_JSON),
) });
