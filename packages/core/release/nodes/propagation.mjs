import { runOperation } from "../../runtime/action-process.mjs";
import {
  controllerIdentities,
  writePropagationInputs,
  planPropagation,
  resolvePropagationBranch,
  capturePropagationWork,
  writePropagationLock,
} from "./propagation-plan.mjs";
import {
  recordMaterialization,
  recordDelivery,
  exposePropagationWork,
  propagationReceipt,
  summarizePropagation,
  refreshPropagationBadges,
} from "./propagation-work.mjs";
import {
  preparePropagationOutcome,
  openPropagationPr,
} from "./propagation-pull-request.mjs";
await runOperation({
  identities: controllerIdentities,
  inputs: writePropagationInputs,
  plan: planPropagation,
  branch: resolvePropagationBranch,
  work: capturePropagationWork,
  lock: writePropagationLock,
  badges: refreshPropagationBadges,
  "record-materialization": recordMaterialization,
  summary: summarizePropagation,
  "pr-outcome": preparePropagationOutcome,
  "open-pr": openPropagationPr,
  receipt: propagationReceipt,
  "record-delivery": recordDelivery,
  "work-output": exposePropagationWork,
});
