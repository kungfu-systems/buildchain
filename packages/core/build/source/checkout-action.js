import path from "node:path";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
export function verifySourceCheckoutAction(core, env) {
  verifyCheckoutIdentity({
    directory: path.resolve(
      env.GITHUB_WORKSPACE,
      core.getInput("source-directory"),
    ),
    sha: core.getInput("source-sha", { required: true }),
    label: "Consumer source",
  });
}
