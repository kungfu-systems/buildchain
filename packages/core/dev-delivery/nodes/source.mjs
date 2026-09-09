import { outputs } from "./io.mjs";
import { runOperation } from "../../runtime/action-process.mjs";
import {
  sourceCoordinates,
  validateNativeContract,
  validateRuntimeSelector,
} from "./source-coordinates.mjs";
import {
  rootRuntime,
  verifyProjectCut,
  qualifySource,
  sealSourceProof,
} from "./source-proof.mjs";
import { assertBranchUnlocked } from "./protected-branch.mjs";
await runOperation({
  target: (env) => outputs(sourceCoordinates(env)),
  contract: validateNativeContract,
  selector: validateRuntimeSelector,
  runtime: rootRuntime,
  unlocked: assertBranchUnlocked,
  "project-cut": verifyProjectCut,
  qualify: qualifySource,
  proof: sealSourceProof,
});
