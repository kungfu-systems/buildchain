import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  inspectPublicationAuthorityAction,
  verifyPublicationGovernanceAction,
} from "../packages/core/publication/authority/actions.js";
import { publicationAuthorityRequest } from "../packages/core/publication/authority/request.js";
import { publicationControlPlaneRequest } from "../packages/core/publication/authority/control-plane.js";

const sourceSha = "a".repeat(40);
const selection = {
  schema: "buildchain.runtime-selection/v1",
  protocol: 1,
  repository: "kungfu-systems/buildchain",
  sha: "b".repeat(40),
  origin: "runtime-parameter",
  ref: "train/v4/v4.1/publication-repair",
};
const request = {
  "auto-admission": true,
  "auto-admission-kind": "binary-release-assets",
  "auto-no-gate": true,
  "source-sha": sourceSha,
  "target-ref": "alpha/v4/v4.1",
  "publication-version": "4.1.0-alpha.1",
  "evidence-repository": "kungfu-systems/buildchain",
  "publisher-workflow-path": ".github/workflows/.release-binary-assets.yml",
};
const env = {
  GITHUB_REPOSITORY: "kungfu-systems/buildchain",
  GITHUB_SHA: sourceSha,
  GITHUB_WORKSPACE: path.join(os.tmpdir(), "publication-consumer-source"),
  BUILDCHAIN_RUNTIME_SELECTION: JSON.stringify(selection),
};
const core = (input = request) => ({
  getInput: (name) => name === "request-json" ? JSON.stringify(input) : "fixture-token",
});

test("publication admission needs source and effect authority without a caller runtime SHA", () => {
  assert.doesNotThrow(() => inspectPublicationAuthorityAction(core(), env));
  for (const extra of [
    { "source-sha": "main" },
    { "target-ref": "dev/v4/v4.1" },
    { "publisher-workflow-path": ".github/workflows/unadmitted.yml" },
    { "evidence-repository": "attacker/project" },
    { "gate-aggregate-json": "{}" },
  ]) assert.throws(() => inspectPublicationAuthorityAction(core({ ...request, ...extra }), env));
});

test("prepared runtime provenance overrides request metadata and preserves distinct consumer source", () => {
  const actual = publicationAuthorityRequest({
    ...request,
    "runtime-sha": "c".repeat(40),
    "runtime-repository": "attacker/runtime",
  }, selection);
  assert.equal(actual.runtimeSha, selection.sha);
  assert.equal(actual.runtimeRepository, selection.repository);
  assert.equal(actual.sourceSha, sourceSha);
  const audit = publicationControlPlaneRequest(actual);
  assert.equal(audit.workflowRef, selection.sha);
  assert.equal(audit.workflowRepository, selection.repository);
  assert.equal(audit.sourceSha, sourceSha);
  assert.equal(audit.environment, "buildchain-release-assets");
});

test("governance adapter uses selected runtime provenance from a separate consumer workspace", () => {
  let calls = 0;
  const receipt = verifyPublicationGovernanceAction(core(), env, {
    verify: (input) => {
      calls += 1;
      assert.equal(input.runtimeSha, selection.sha);
      assert.equal(input.repository, env.GITHUB_REPOSITORY);
      assert.equal(input.targetRef, request["target-ref"]);
      assert.equal(input.outputRoot, path.join(env.GITHUB_WORKSPACE, ".buildchain/publication-authority"));
      assert.notEqual(input.runtimeRoot, env.GITHUB_WORKSPACE);
      return { verdict: "fixture-governance-verified" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(receipt.verdict, "fixture-governance-verified");
});
