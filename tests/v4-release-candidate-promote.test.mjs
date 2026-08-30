import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCandidateBuildSummaryPath } from "../actions/v4-release-candidate-promote/index.js";

test("legacy promotion shells recover the standard sealed build summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(
    root,
    "passport",
    "release-candidate-passport.json",
  );
  const summary = path.join(root, "summary", "build-summary.json");
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(passport, "{}\n");
  fs.writeFileSync(summary, "{}\n");

  assert.equal(
    resolveCandidateBuildSummaryPath({ candidatePassportPath: passport }),
    summary,
  );
  assert.equal(
    resolveCandidateBuildSummaryPath({
      candidatePassportPath: passport,
      declaredPath: "explicit/build-summary.json",
    }),
    "explicit/build-summary.json",
  );
});

test("legacy promotion shells fail closed without the standard summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(
    root,
    "passport",
    "release-candidate-passport.json",
  );
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.writeFileSync(passport, "{}\n");

  assert.throws(
    () => resolveCandidateBuildSummaryPath({ candidatePassportPath: passport }),
    /candidate-build-summary-path is required/,
  );
});
