import fs from "node:fs";
import path from "node:path";
import { normalizeOptions } from "./policy.js";
import { runDevPrAdmission, renderAdmissionComment } from "./targeted.js";
import { runDevPrAutoMerge } from "./queue.js";
import { renderMarkdownSummary } from "./report.js";
export async function runAdmissionTransaction(
  input,
  connection,
  dependencies = {},
) {
  const options = normalizeOptions(input);
  const targeted =
    options.targetPullRequestNumber > 0 || Boolean(options.expectedHeadSha);
  const result = targeted
    ? await (dependencies.admit || runDevPrAdmission)({
        ...options,
        ...connection,
      })
    : await (dependencies.merge || runDevPrAutoMerge)({
        ...options,
        ...connection,
      });
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = targeted
    ? `${renderAdmissionComment(result.receipt, result.receiptRoot)}\n`
    : renderMarkdownSummary(result);
  const outputs = {
    "evaluated-count": targeted ? 1 : result.evaluated.length,
    "merged-count": targeted
      ? Number(result.receipt.state === "merged")
      : result.merged.length,
    "enqueued-count": targeted
      ? Number(result.receipt.state === "queued")
      : result.enqueued.length,
    "action-count": targeted ? Number(result.ok) : result.actions.length,
    "skipped-count": targeted ? Number(!result.ok) : result.skipped.length,
    "final-base-sha": targeted ? "" : result.finalBaseSha,
    targeted: targeted,
    "targeted-ok": targeted ? result.ok : "",
    "admission-state": targeted ? result.receipt.state : "",
    "receipt-root": targeted ? result.receiptRoot : "",
    "result-path": options.outputPath,
  };
  return { result, summary, outputs, ok: !targeted || result.ok };
}
