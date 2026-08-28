import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/resolve-build-summary-names.sh");

function resolveNames(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-summary-names-"));
  const output = path.join(root, "output");
  try {
    execFileSync("bash", [script], {
      env: {
        ...process.env,
        BUILDCHAIN_SUMMARY_ARTIFACT_NAME: "summary",
        BUILDCHAIN_DIAGNOSTICS_SUMMARY_ARTIFACT_NAME: "diagnostics",
        BUILDCHAIN_RC_PASSPORT_ARTIFACT_NAME: "passport",
        BUILDCHAIN_RC_REQUESTED: "true",
        BUILDCHAIN_RC_TARGET_CHANNEL: "none",
        BUILDCHAIN_RC_PR_BASE_REF: "",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: output,
        ...overrides,
      },
    });
    return Object.fromEntries(
      fs.readFileSync(output, "utf8").trimEnd().split("\n").map((line) => line.split(/=(.*)/s, 2)),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("explicit release-candidate channel remains authoritative", () => {
  const outputs = resolveNames({
    BUILDCHAIN_RC_TARGET_CHANNEL: "release",
    BUILDCHAIN_RC_PR_BASE_REF: "alpha/v4/v4.0",
  });
  assert.equal(outputs["release-candidate-enabled"], "true");
  assert.equal(outputs["release-candidate-target-channel"], "release");
  assert.equal(outputs["release-candidate-passport-artifact-name"], "passport");
});

test("pull-request bases recover only the supported release-candidate channels", () => {
  for (const [baseRef, channel] of [
    ["alpha/v4/v4.0", "alpha"],
    ["release/v4/v4.0", "release"],
    ["publish-gate/major", "major"],
    ["major-gate", "major"],
  ]) {
    assert.equal(resolveNames({ BUILDCHAIN_RC_PR_BASE_REF: baseRef })["release-candidate-target-channel"], channel);
  }
});

test("non-PR events do not infer a release-candidate channel", () => {
  const outputs = resolveNames({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    BUILDCHAIN_RC_PR_BASE_REF: "release/v4/v4.0",
  });
  assert.equal(outputs["release-candidate-enabled"], "false");
  assert.equal(outputs["release-candidate-target-channel"], "none");
  assert.equal(outputs["release-candidate-passport-artifact-name"], "");
});
