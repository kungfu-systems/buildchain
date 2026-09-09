import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";
import { readCandidateReview } from "./bootstrap-review.mjs";
import {
  readJson,
  writeJson,
  engine,
  backflow,
  outputs,
  candidateResultOutputs,
} from "./bootstrap-io.mjs";

const trusted = ".buildchain/bootstrap";
const candidate = ".buildchain/candidate";
await runOperation({
  inspect: () => {
    const value = engine(
      trusted,
      "inspect",
      ".buildchain/request-inspection.json",
    );
    outputs({
      mode: value.mode,
      repository: value.candidate.repository,
      "discovery-ref": value.candidate.discoveryRef,
      "expected-sha": value.candidate.expectedSha,
      "review-pr": value.candidate.reviewPullRequest,
      "capability-id": value.capability.id,
    });
  },
  review: (env) =>
    writeJson(
      ".buildchain/review-evidence.json",
      readCandidateReview({
        mode: env.CANDIDATE_MODE,
        candidate: {
          repository: env.CANDIDATE_REPOSITORY,
          expectedSha: env.CANDIDATE_EXPECTED_SHA,
          reviewPullRequest: Number(env.CANDIDATE_REVIEW_PR),
        },
      }),
    ),
  admit: (env) => {
    const admitted = engine(trusted, "admit", ".buildchain/admission.json", {
      ...env,
      BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON: JSON.stringify(
        readJson(
          `${candidate}/architecture/universal-workflow-train-admission.json`,
        ),
      ),
      BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON: JSON.stringify(
        readJson(".buildchain/review-evidence.json"),
      ),
      BUILDCHAIN_UNIVERSAL_OBSERVED_SHA: command(
        "git",
        ["-C", candidate, "rev-parse", "HEAD"],
        { stdio: ["ignore", "pipe", "inherit"] },
      )
        .trim()
        .toLowerCase(),
      BUILDCHAIN_UNIVERSAL_OBSERVED_AT: new Date().toISOString(),
    });
    outputs({
      "runtime-sha": admitted.runtime.sha,
      "request-root": admitted.requestRoot,
      "admission-root": admitted.admissionRoot,
      "admission-json": JSON.stringify(admitted),
    });
  },
  execute: () => {
    const value = engine(candidate, "execute", ".buildchain/result.json");
    outputs(candidateResultOutputs(value));
  },
  terminal: (env) => {
    const value = engine(
      trusted,
      "terminal",
      ".buildchain/terminal-receipt.json",
    );
    outputs({
      "terminal-receipt-json": JSON.stringify(value),
      "terminal-receipt-root": value.receiptRoot,
    });
    requireValue(
      JSON.parse(env.BUILDCHAIN_UNIVERSAL_RESULT_JSON).status === "succeeded",
      "Candidate workflow failed after sealing its terminal receipt",
    );
  },
  backflow: () =>
    outputs({
      "backflow-root":
        backflow(trusted, ".buildchain/backflow.json").backflowRoot || "",
    }),
});
