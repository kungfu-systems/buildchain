import { runOperation } from "../../runtime/action-process.mjs";
import {
  validateTerminalIntent,
  resolveSettlement,
  sealTerminalEvidence,
  settleTerminal,
  wakeSuccessor,
} from "./terminal-settlement.mjs";
import { settleNativeFailure } from "./failure-settlement.mjs";
await runOperation({
  intent: validateTerminalIntent,
  mode: resolveSettlement,
  evidence: sealTerminalEvidence,
  close: settleTerminal,
  wake: wakeSuccessor,
  failure: settleNativeFailure,
});
