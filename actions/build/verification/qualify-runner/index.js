import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyRunnerCompatibilityAction } from "../../../../packages/core/build/verification/runner.js";

await runAction(qualifyRunnerCompatibilityAction);
