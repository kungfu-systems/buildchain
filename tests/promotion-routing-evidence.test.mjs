import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPromotionRoutingEvidence } from "../scripts/promotion-routing-evidence.mjs";

test("promotion routing evidence preserves the workflow routing contract", () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-promotion-routing-"),
  );
  const passportPath = path.join(cwd, "release-candidate-passport.json");
  const outputPath = path.join(cwd, "github-output.txt");
  fs.writeFileSync(
    passportPath,
    JSON.stringify({ schemaVersion: 1, candidate: "fixture" }),
  );
  const env = {
    ROUTER_REF: "buildchain/v3",
    ROUTER_SHA: "1".repeat(40),
    SHELL_CHANNEL: "stable",
    SHELL_REF: "release/v3/v3.0",
    SHELL_SHA: "2".repeat(40),
    RUNTIME_REF: "v3.0.1",
    RUNTIME_SHA: "3".repeat(40),
    LOCK_PATH: ".buildchain/buildchain-contract-lock.json",
    LOCK_DIGEST: `sha256:${"4".repeat(64)}`,
    PUBLICATION_CHANNEL: "release",
    TARGET_REF: "release/v3/v3.0",
    OVERRIDE_USED: "false",
    RELEASE_CANDIDATE_PASSPORT: passportPath,
    GITHUB_OUTPUT: outputPath,
  };

  const result = createPromotionRoutingEvidence({ cwd, env });
  const routing = JSON.parse(fs.readFileSync(result.routingPath, "utf8"));
  const candidate = JSON.parse(fs.readFileSync(result.candidatePath, "utf8"));
  assert.equal(routing.contract, "buildchain.promotion-routing/v1");
  assert.deepEqual(routing.publication, {
    channel: "release",
    targetRef: "release/v3/v3.0",
  });
  assert.equal(routing.trustedOverrideUsed, false);
  assert.deepEqual(candidate.promotionRouting, routing);
  assert.equal(candidate.candidate, "fixture");
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    [
      "routing-path=.buildchain/controller/promotion-routing.json",
      "candidate-passport-path=.buildchain/controller/release-candidate-promotion-passport.json",
      "",
    ].join("\n"),
  );
});

test("release promotion workflow delegates routing mechanics to shell-owned helpers", () => {
  const workflow = fs.readFileSync(
    path.resolve(".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const promoteJob = workflow.slice(
    workflow.indexOf("\n  promote:"),
    workflow.indexOf("\n  github-artifact-attestation:"),
  );
  const checkoutShell = promoteJob.indexOf(
    "path: .buildchain/runtime/promotion-shell",
  );
  const recordRouting = promoteJob.indexOf(
    "node .buildchain/runtime/promotion-shell/scripts/promotion-routing-evidence.mjs",
  );
  assert.match(
    workflow,
    /bash \.buildchain\/promotion-shell\/scripts\/verify-promotion-router-binding\.sh/,
  );
  assert.match(
    workflow,
    /node \.buildchain\/promotion-shell\/scripts\/promotion-routing-evidence\.mjs/,
  );
  assert.ok(checkoutShell >= 0, "promote job must checkout the selected shell");
  assert.ok(
    checkoutShell < recordRouting,
    "promote job must checkout the selected shell before using its helper",
  );
  assert.doesNotMatch(workflow, /node <<'NODE'[\s\S]*buildchain\.promotion-routing\/v1/);
});
