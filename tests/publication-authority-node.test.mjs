import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  requireImmutableAuthority,
  requireSealedInputs,
  requireManagedInputs,
} from "../packages/core/publication/nodes/authority-admission.mjs";
import {
  controlPlaneArguments,
  resolveControllerEvidence,
  recordAuthorityDryRun,
  exportAuthorityResult,
} from "../packages/core/publication/nodes/authority-io.mjs";
import { payloadFor } from "../packages/core/publication/nodes/authority-evidence.mjs";
import {
  validateCapabilityBinding,
  verifySealedAdmission,
} from "../packages/core/publication/nodes/authority-verification.mjs";

const sha = "a".repeat(40);
function workspace(fn) {
  const old = process.cwd(),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-authority-node-"));
  process.chdir(root);
  try {
    return fn(root);
  } finally {
    process.chdir(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function managed(extra = {}) {
  return {
    GITHUB_REPOSITORY: "acme/project",
    BUILDCHAIN_REPOSITORY: "kungfu-systems/buildchain",
    BUILDCHAIN_SOURCE_SHA: sha,
    BUILDCHAIN_TARGET_REF: "alpha/v4/v4.1",
    BUILDCHAIN_PUBLICATION_VERSION: "4.1.0-alpha.0",
    BUILDCHAIN_AUTO_ADMISSION_KIND: "release-candidate",
    BUILDCHAIN_EVIDENCE_REPOSITORY: "acme/project",
    BUILDCHAIN_PUBLISHER_WORKFLOW_PATH:
      ".github/workflows/public-release-promote.yml",
    BUILDCHAIN_PUBLICATION_TARGET: "npm:@acme/project",
    BUILDCHAIN_PACKAGE_NAME: "@acme/project",
    BUILDCHAIN_AUTO_NO_GATE: "true",
    ...extra,
  };
}
test("authority admission rejects mutable runtimes, incomplete evidence, obsolete channels and conflicting gate sources", () => {
  requireImmutableAuthority({ BUILDCHAIN_AUTHORITY_REF: sha });
  for (const ref of ["v4-alpha", "a".repeat(64), ""])
    assert.throws(
      () => requireImmutableAuthority({ BUILDCHAIN_AUTHORITY_REF: ref }),
      /exact/,
    );
  assert.throws(() => requireSealedInputs({}), /before artifact download/);
  requireManagedInputs(managed());
  requireManagedInputs(
    managed({ BUILDCHAIN_TARGET_REF: "publish-gate/major" }),
  );
  for (const extra of [
    { BUILDCHAIN_TARGET_REF: "major-gate" },
    { BUILDCHAIN_EVIDENCE_REPOSITORY: "attacker/project" },
    { BUILDCHAIN_GATE_AGGREGATE_JSON: "{}" },
    { BUILDCHAIN_CONSUMER_QUALIFICATION_REQUIRED: "true" },
    { BUILDCHAIN_CONSUMER_GATE_CONTROLLER_SHA: sha },
  ])
    assert.throws(() => requireManagedInputs(managed(extra)));
});
test("binary and artifact authority use distinct exact publisher and gate contracts", () => {
  const binary = managed({
    BUILDCHAIN_AUTO_ADMISSION_KIND: "binary-release-assets",
    BUILDCHAIN_EVIDENCE_REPOSITORY: "kungfu-systems/buildchain",
    BUILDCHAIN_PUBLISHER_WORKFLOW_PATH:
      ".github/workflows/.release-binary-assets.yml",
  });
  requireManagedInputs(binary);
  assert.throws(
    () =>
      requireManagedInputs({ ...binary, BUILDCHAIN_GATE_AGGREGATE_JSON: "{}" }),
    /exactly one/,
  );
  assert.throws(
    () =>
      requireManagedInputs({
        ...binary,
        BUILDCHAIN_PUBLISHER_WORKFLOW_PATH: ".github/workflows/other.yml",
      }),
    /sealed binary/,
  );
  requireManagedInputs(
    managed({ BUILDCHAIN_AUTO_ADMISSION_KIND: "publication-artifact" }),
  );
});
test("publication audits pass input values as literal argv and preserve provider-specific boundaries", () => {
  const input = {
    "evidence-repository": "acme/repo",
    "buildchain-repository": "kungfu-systems/buildchain",
    "target-ref": "alpha/v4/v4.1",
    "source-sha": sha,
    "buildchain-ref": sha,
    "publisher-workflow-path": ".github/workflows/publish.yml",
    "required-status-check": "check",
    "publication-version": "4.1.0-alpha.0",
    "package-name": "$(touch /tmp/never)",
    "publication-target": "npm:pkg",
  };
  const npm = controlPlaneArguments(input, "candidate");
  assert.equal(npm[npm.indexOf("--package") + 1], input["package-name"]);
  assert.equal(
    npm[npm.indexOf("--publisher-mode") + 1],
    "npm-trusted-publisher",
  );
  const binary = controlPlaneArguments(input, "binary");
  assert.equal(
    binary[binary.indexOf("--environment") + 1],
    "buildchain-release-assets",
  );
  assert.ok(binary.includes("--allow-release-reconciliation"));
  assert.ok(!binary.includes("--package"));
  const github = controlPlaneArguments(
    { ...input, "publication-target": "github-release:acme/repo" },
    "candidate",
  );
  assert.equal(github[github.indexOf("--publisher-mode") + 1], "github-token");
  assert.throws(() => controlPlaneArguments(input, "unknown"), /Unknown/);
});
test("controller artifact selection rejects ambiguity and workflow output injection", () =>
  workspace((root) => {
    const dir = ".buildchain/publication-evidence/passport";
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "release-candidate-passport.json");
    const env = { GITHUB_OUTPUT: path.join(root, "output") };
    fs.writeFileSync(
      file,
      JSON.stringify({
        controllerReceipts: [{ artifact: "exact-controller" }],
      }),
    );
    resolveControllerEvidence(env);
    assert.equal(
      fs.readFileSync(env.GITHUB_OUTPUT, "utf8"),
      "controller-artifact=exact-controller\n",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        controllerReceipts: [{ artifact: "controller\nforged=value" }],
      }),
    );
    assert.throws(() => resolveControllerEvidence(env), /line breaks/);
    fs.mkdirSync(path.join(dir, "duplicate"));
    fs.copyFileSync(
      file,
      path.join(dir, "duplicate", "release-candidate-passport.json"),
    );
    assert.throws(() => resolveControllerEvidence(env), /exactly one/);
  }));
test("candidate payload evidence rejects unsafe artifact names, traversal and escaping symlinks", () =>
  workspace((root) => {
    const dir = ".buildchain/publication-evidence/payloads/package";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ok.txt"), "payload");
    assert.equal(
      payloadFor({ artifactName: "package", files: [{ path: "ok.txt" }] })
        .files[0].size,
      7,
    );
    for (const name of ["..", "../outside", "a/b", "a\\b"])
      assert.throws(
        () => payloadFor({ artifactName: name, files: [] }),
        /safe path/,
      );
    assert.throws(
      () =>
        payloadFor({
          artifactName: "package",
          files: [{ path: "../outside" }],
        }),
      /unsafe path/,
    );
    fs.writeFileSync(path.join(root, "outside"), "private");
    fs.symlinkSync(path.join(root, "outside"), path.join(dir, "link"));
    assert.throws(
      () => payloadFor({ artifactName: "package", files: [{ path: "link" }] }),
      /escapes/,
    );
  }));
test("capability binding requires explicit qualification and exact runtime/version/predicate", () => {
  const env = {
    BUILDCHAIN_AUTO_ADMISSION_KIND: "release-candidate",
    BUILDCHAIN_PLANNED_PUBLICATION_VERSION: "4.1.0-alpha.0",
    BUILDCHAIN_CONSUMER_QUALIFICATION_REQUIRED: "false",
  };
  const value = {
    runtimeSha: sha,
    version: env.BUILDCHAIN_PLANNED_PUBLICATION_VERSION,
    qualification: { required: false },
  };
  validateCapabilityBinding(value, env, sha);
  assert.throws(
    () =>
      validateCapabilityBinding(
        { ...value, qualification: undefined },
        env,
        sha,
      ),
    /must declare/,
  );
  assert.throws(
    () => validateCapabilityBinding(value, env, "b".repeat(40)),
    /runtime checkout mismatch/,
  );
  assert.throws(
    () => validateCapabilityBinding({ ...value, version: "4.0.0" }, env, sha),
    /version mismatch/,
  );
  assert.throws(
    () =>
      validateCapabilityBinding(
        {
          ...value,
          qualification: {
            required: true,
            predicateId: "other",
            predicateDigest: "x",
          },
        },
        {
          ...env,
          BUILDCHAIN_CONSUMER_QUALIFICATION_REQUIRED: "true",
          BUILDCHAIN_CONSUMER_PREDICATE_ID: "expected",
        },
        sha,
      ),
    /predicate binding/,
  );
});
test("wrong authority checkout is rejected before GitHub evidence requests", async () => {
  let requests = 0;
  await assert.rejects(
    verifySealedAdmission(
      {
        BUILDCHAIN_PUBLICATION_ADMISSION_JSON: JSON.stringify({
          repository: "acme/project",
          sourceSha: sha,
        }),
        BUILDCHAIN_AUTHORITY_REF: sha,
      },
      {
        execute: () => "b".repeat(40),
        request: async () => {
          requests++;
          throw Error("unexpected request");
        },
      },
    ),
    /runtime checkout mismatch/,
  );
  assert.equal(requests, 0);
});
test("dry-run receipt has no publishing capability and workflow retains permissions and explicit phase edges", () =>
  workspace((root) => {
    recordAuthorityDryRun();
    const env = { GITHUB_OUTPUT: path.join(root, "output") };
    exportAuthorityResult(env);
    const text = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
    assert.match(text, /"decision":"dry-run"/);
    assert.match(text, /capability-digest=\n/);
  }));
test("publication authority exposes five phase nodes with original least-privilege job boundary", () => {
  const w = YAML.parse(
    fs.readFileSync(".github/workflows/.release-authority.yml", "utf8"),
  );
  assert.equal(w.jobs.verify.steps.length, 6);
  assert.deepEqual(w.jobs.verify.permissions, {
    actions: "read",
    checks: "read",
    contents: "read",
    "pull-requests": "read",
  });
  assert.ok(w.jobs.verify.steps.every((s) => s.uses && !s.run));
  const admit = YAML.parse(
    fs.readFileSync("actions/publication/authority-admit/action.yml", "utf8"),
  );
  assert.ok(
    admit.runs.steps.findIndex(
      (s) => s.name === "Require an immutable authority runtime",
    ) <
      admit.runs.steps.findIndex(
        (s) => s.name === "Checkout exact Buildchain authority runtime",
      ),
  );
  const candidate = YAML.parse(
    fs.readFileSync(
      "actions/publication/authority-candidate-evidence/action.yml",
      "utf8",
    ),
  );
  const gate = candidate.runs.steps.find((s) => s.id === "consumer-gate");
  assert.match(gate.run, /\$GITHUB_WORKSPACE\/\.buildchain\/authority-runtime/);
  assert.match(gate.env.BUILDCHAIN_NODE_PATH, /inputs.node-path/);
});
