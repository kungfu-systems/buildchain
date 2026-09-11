import {
  createControllerPlan,
  createControllerReceipt,
  validateControllerReceipt,
} from "../observability/controller-evidence.js";
import { validateReleasePassportSchema } from "../release/release-passport-contract.js";
import { requireValue } from "../runtime/action-process.mjs";

function requireCandidate(receipt, source, runtime) {
  const result = validateControllerReceipt(receipt, {
    expectedSourceSha: source.sha,
  });
  requireValue(
    result.qualifying &&
      receipt.controller.id === "publication-artifact" &&
      receipt.source.repository === source.repository,
    "Paper candidate controller must qualify for the exact source",
  );
}

export function createPaperControllerPlan({
  descriptor,
  candidateReceipt,
  source,
  runtime,
  inputs,
}) {
  requireCandidate(candidateReceipt, source, runtime);
  return createControllerPlan({
    descriptor,
    source,
    runtime,
    inputs: {
      ...inputs,
      "candidate-receipt-digest": candidateReceipt.digest,
    },
  });
}

export function requirePaperReleasePassport(
  passport,
  { repository, sourceSha, tag },
) {
  requireValue(
    validateReleasePassportSchema(passport).ok,
    "Paper release Passport must satisfy the current schema",
  );
  requireValue(
    passport.product.repository === repository &&
      passport.release.sourceSha === sourceSha &&
      passport.release.tag === tag,
    "Paper release Passport must bind the exact repository, source and tag",
  );
}

function outcomeStatus(outcome) {
  return (
    {
      success: "passed",
      failure: "failed",
      cancelled: "cancelled",
      skipped: "skipped",
    }[outcome] || "missing"
  );
}

export function createPaperControllerReceipt({
  plan,
  candidateReceipt,
  publishOutcome,
  readbackOutcome,
  aggregateOutcome,
  passport,
  tag,
  evidence = [],
  artifact = "",
}) {
  let candidateValid = false;
  let passportValid = false;
  const failures = [];
  try {
    requireCandidate(candidateReceipt, plan.source, plan.runtime);
    requireValue(
      candidateReceipt.digest === plan.inputs["candidate-receipt-digest"].value,
      "Paper candidate receipt changed after admission",
    );
    candidateValid = true;
  } catch (error) {
    failures.push(error.message);
  }
  if (publishOutcome === "success" && readbackOutcome === "success") {
    try {
      requirePaperReleasePassport(passport, {
        repository: plan.source.repository,
        sourceSha: plan.source.sha,
        tag,
      });
      passportValid = true;
    } catch (error) {
      failures.push(error.message);
    }
  }
  const stages = ["resolve-runtime", "build", "verify", "collect"].map(
    (id) => ({
      id,
      status: candidateValid
        ? candidateReceipt.stages.find((stage) => stage.id === id)?.status ||
          "missing"
        : "failed",
    }),
  );
  stages.push(
    { id: "publication-authority", status: "passed" },
    { id: "publish", status: outcomeStatus(publishOutcome) },
    {
      id: "passport",
      status: passportValid
        ? "passed"
        : readbackOutcome === "success"
          ? "failed"
          : outcomeStatus(readbackOutcome),
    },
    {
      id: "aggregate",
      status: failures.length ? "failed" : outcomeStatus(aggregateOutcome),
    },
  );
  return createControllerReceipt({
    plan,
    stages,
    artifact,
    evidence: evidence.filter(
      (item) => item.kind !== "release-passport" || passportValid,
    ),
    reason: {
      code: "paper-publication-incomplete",
      summary:
        failures.join("; ") ||
        "Paper publication did not complete every required stage",
    },
  });
}
