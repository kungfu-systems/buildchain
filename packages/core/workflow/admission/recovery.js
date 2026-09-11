import { assertResultLineage } from "../engine/execution.js";
import { completeUniversalWorkflow } from "../universal-workflow-bootstrap.js";

export function recoveryTerminalReceipt(admission, result) {
  assertResultLineage(admission, result);
  return completeUniversalWorkflow({ admission, resultRoot: result.resultRoot, status: result.status });
}
