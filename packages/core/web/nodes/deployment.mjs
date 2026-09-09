import { command, runOperation } from "../../runtime/action-process.mjs";
import {
  writeOutputs,
  selectWebOutputs,
  deploymentArguments,
  selectProductionEvidence,
  verifyWebGovernance,
} from "./deployment-io.mjs";
import { webTokenConfig, webTokenSource } from "./deployment-token.mjs";
import { summarizeDeployment } from "./deployment-summary.mjs";

await runOperation({
  select: (env) => writeOutputs(env, selectWebOutputs()),
  "token-config": (env) => writeOutputs(env, webTokenConfig(env)),
  "token-source": (env) => writeOutputs(env, webTokenSource(env)),
  summary: summarizeDeployment,
  governance: verifyWebGovernance,
  "production-evidence": selectProductionEvidence,
  ...Object.fromEntries(
    ["deploy", "cleanup", "preflight", "health"].map((operation) => [
      operation,
      (env) => command(process.execPath, deploymentArguments(env, operation)),
    ]),
  ),
});
