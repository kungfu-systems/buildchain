import fs from "node:fs";
import path from "node:path";
import { recoveryTerminalReceipt } from "../admission/recovery.js";
export function sealUniversalReceiptAction(core, env) {
  const admission = JSON.parse(
      core.getInput("admission-json", { required: true }),
    ),
    result = JSON.parse(core.getInput("result-json", { required: true }));
  const receipt = recoveryTerminalReceipt(admission, result);
  const file = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/terminal-receipt.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  core.setOutput("terminal-receipt-json", JSON.stringify(receipt));
  core.setOutput("terminal-receipt-root", receipt.receiptRoot);
  if (result.status !== "succeeded")
    throw new Error(
      "Candidate workflow failed after sealing its terminal receipt",
    );
}
