import { requireValue, runOperation } from "../../runtime/action-process.mjs";
import { readCandidateReview } from "./bootstrap-review.mjs";
import {
  recoveryCoordinates,
  recoveryTerminalReceipt,
} from "./recovery-contract.mjs";
import {
  readJson,
  writeJson,
  engine,
  backflow,
  outputs,
} from "./bootstrap-io.mjs";

const candidate = ".buildchain/candidate";
await runOperation({
  request: (env) => {
    const request = JSON.parse(env.REQUEST_JSON);
    const coordinates = recoveryCoordinates(request);
    writeJson(".buildchain-request.json", request);
    outputs(coordinates);
  },
  review: () => {
    const request = readJson(".buildchain-request.json");
    recoveryCoordinates(request);
    writeJson(".buildchain-review-evidence.json", readCandidateReview(request));
  },
  admit: (env) => {
    const admitted = engine(candidate, "admit", ".buildchain-admission.json", {
      ...env,
      BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON: JSON.stringify(
        readJson(
          `${candidate}/architecture/universal-workflow-train-admission.json`,
        ),
      ),
      BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(
        readJson(".buildchain-review-evidence.json"),
      ),
      BUILDCHAIN_UNIVERSAL_OBSERVED_SHA: env.EXPECTED_SHA,
      BUILDCHAIN_UNIVERSAL_OBSERVED_AT: new Date().toISOString(),
    });
    outputs({
      "runtime-sha": admitted.runtime.sha,
      "admission-json": JSON.stringify(admitted),
    });
  },
  execute: () =>
    outputs({
      "result-json": JSON.stringify(
        engine(candidate, "execute", ".buildchain-result.json"),
      ),
    }),
  terminal: (env) => {
    const result = JSON.parse(env.BUILDCHAIN_UNIVERSAL_RESULT_JSON);
    const receipt = recoveryTerminalReceipt(
      JSON.parse(env.BUILDCHAIN_UNIVERSAL_ADMISSION_JSON),
      result,
    );
    writeJson(".buildchain-terminal.json", receipt);
    outputs({
      "terminal-receipt-json": JSON.stringify(receipt),
      "terminal-receipt-root": receipt.receiptRoot,
    });
    requireValue(
      result.status === "succeeded",
      "Candidate recovery failed after sealing its terminal receipt",
    );
  },
  backflow: () =>
    outputs({
      "backflow-root":
        backflow(candidate, ".buildchain-backflow.json").backflowRoot || "",
    }),
});
