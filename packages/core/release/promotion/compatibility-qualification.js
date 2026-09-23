import { historicalEvidenceKeys } from "./historical-evidence.js";
import fs from "node:fs";
import { historicalPromotionContext } from "./compatibility-context.js";

export function historicalRecoveryPins(request, runtimeSha) {
  const inputs = historicalPromotionContext(
    request["historical-inputs-json"],
  )?.inputs;
  if (!inputs) return "";
  const selected = inputs["resume-buildchain-runtime-sha"];
  if (selected && selected !== runtimeSha)
    throw new Error("Historical recovery runtime does not match its exact pin");
  const expected = inputs["resume-expected-candidate-runtime-sha"] || "";
  if (expected && !request["resume-candidate-run-id"])
    throw new Error(
      "Historical candidate runtime pin requires a candidate recovery run",
    );
  return expected;
}

export function verifyHistoricalCandidateRuntime(candidate, expected) {
  if (expected) {
    const passport = JSON.parse(
      fs.readFileSync(candidate.paths.passport, "utf8"),
    );
    if (passport.buildchain?.sha !== expected)
      throw new Error(
        "Historical recovered candidate does not match its runtime pin",
      );
  }
  return candidate;
}

// A retained input must never be accepted and then silently ignored. Each
// command requires its original execution/evidence contract before enabling it.
export function assertHistoricalPromotionEffects(request) {
  const inputs =
    historicalPromotionContext(request["historical-inputs-json"])?.inputs || {};
  for (const [key, value] of Object.entries(inputs))
    if (
      key.endsWith("-command") &&
      value &&
      !historicalEvidenceKeys.includes(key)
    )
      throw new Error(
        `Historical promotion command adapter is not implemented: ${key}`,
      );
}
