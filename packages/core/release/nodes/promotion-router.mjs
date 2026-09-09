import { runOperation } from "../../runtime/action-process.mjs";
import { bindPromotionSelection } from "./promotion-selection.mjs";
import { admitPromotionConsumer } from "./promotion-admission.mjs";
import { bindPromotionInvocation } from "../promotion-request.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
await runOperation({bind:bindPromotionSelection,admit:admitPromotionConsumer, invocation: (env) => {
  const invocation = bindPromotionInvocation(env.BUILDCHAIN_PROMOTION_REQUEST_JSON, JSON.parse(env.BUILDCHAIN_PROMOTION_SELECTION_JSON), {
    "runtime-authorization-json": env.BUILDCHAIN_RUNTIME_AUTHORIZATION_JSON,
    "runtime-authorization-root": env.BUILDCHAIN_RUNTIME_AUTHORIZATION_ROOT,
  });
  writeGitHubOutputs({ "invocation-json": JSON.stringify(invocation) });
}});
