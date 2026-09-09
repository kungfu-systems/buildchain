import { runOperation } from "../../runtime/action-process.mjs";
import {
  planLine,
  summarizeLine,
  writeLine,
  commitAndPushLine,
} from "./line-open-workspace.mjs";
import {
  protectLine,
  reconcileLineQueue,
  setLineDefault,
  openLineAlphaPr,
} from "./line-open-governance.mjs";

await runOperation({
  plan: planLine,
  summary: summarizeLine,
  write: writeLine,
  push: commitAndPushLine,
  protect: protectLine,
  queue: reconcileLineQueue,
  default: setLineDefault,
  "alpha-pr": openLineAlphaPr,
});
