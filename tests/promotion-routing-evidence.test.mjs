import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundlePromotionControllerEvidence,
  createPromotionRoutingEvidence,
} from "../scripts/promotion-routing-evidence.mjs";

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

test("release promotion workflow routes through the canonical invocation boundary", () => {
  const workflow = fs.readFileSync(
    path.resolve(".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const apply = workflow.slice(
    workflow.indexOf("\n  apply:"),
    workflow.indexOf("\n  settle:"),
  );

  assert.match(apply, /uses: \.\/\.buildchain\/runtime\/actions\/v4-release-candidate-promote/);
  assert.match(
    apply,
    /publisher-workflow-sha: \$\{\{ needs\.qualify\.outputs\.publisher-sha \}\}/,
  );
  assert.match(
    apply,
    /runtime-commit: \$\{\{ needs\.qualify\.outputs\.runtime-sha \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /verify-promotion-router-binding\.sh|promotion-routing-evidence\.mjs/,
  );
});

test("promotion evidence bundling preserves exact bytes and finalization boundaries", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-promotion-bundle-"));
  const write = (name, value) => {
    fs.writeFileSync(path.join(cwd, name), value);
    return name;
  };
  const env = {
    RELEASE_CANDIDATE_PASSPORT: write("candidate.json", "candidate\n"),
    PUBLISH_EVIDENCE: write("publish.json", "publish\n"),
    RELEASE_PASSPORT: write("release.json", "release\n"),
    FINALIZATION_NEEDED: "false",
  };
  const result = bundlePromotionControllerEvidence({ cwd, env });
  assert.deepEqual(result.files, [
    "release-candidate-passport.json",
    "publish-evidence.json",
    "release-passport.json",
  ]);
  assert.equal(
    fs.readFileSync(path.join(result.outputDir, "release-passport.json"), "utf8"),
    "release\n",
  );
  assert.throws(
    () =>
      bundlePromotionControllerEvidence({
        cwd,
        env: { ...env, PUBLISH_EVIDENCE: "missing.json" },
      }),
    /promotion controller evidence is missing/u,
  );
});
