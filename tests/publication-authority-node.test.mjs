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
} from "../packages/core/publication/authority/admission.js";
import { publicationControlPlaneRequest } from "../packages/core/publication/authority/control-plane.js";
import { referencedControllerArtifact } from "../packages/core/publication/authority/evidence.js";
import { qualifyPublicationAuthority } from "../packages/core/publication/authority/result.js";
import { payloadFor as readPayload } from "../packages/core/publication/authority/evidence.js";
import {
  validateCapabilityBinding,
  verifySealedAdmission,
} from "../packages/core/publication/authority/verification.js";

const payloadFor = manifest => readPayload(manifest, path.join(process.cwd(), ".buildchain/publication-evidence/payloads"));
const sha = "a".repeat(40);
async function workspace(fn) {
  const old = process.cwd(),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-authority-node-"));
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function managed(extra = {}) {
  return {
    callerRepository: "acme/project",
    buildchainRepository: "kungfu-systems/buildchain",
    sourceSha: sha,
    targetRef: "alpha/v4/v4.1",
    publicationVersion: "4.1.0-alpha.0",
    autoAdmissionKind: "release-candidate",
    evidenceRepository: "acme/project",
    publisherWorkflowPath:
      ".github/workflows/public-release-promote.yml",
    publicationTarget: "npm:@acme/project",
    packageName: "@acme/project",
    autoNoGate: true,
    ...extra,
  };
}
test("authority admission rejects mutable runtimes, incomplete evidence, obsolete channels and conflicting gate sources", () => {
  requireImmutableAuthority({ buildchainRef: sha });
  for (const ref of ["v4-alpha", "a".repeat(64), ""])
    assert.throws(
      () => requireImmutableAuthority({ buildchainRef: ref }),
      /exact/,
    );
  assert.throws(() => requireSealedInputs({}), /before artifact download/);
  requireManagedInputs(managed());
  requireManagedInputs(
    managed({ targetRef: "publish-gate/major" }),
  );
  for (const extra of [
    { targetRef: "major-gate" },
    { evidenceRepository: "attacker/project" },
    { gateAggregateJson: "{}" },
    { consumerQualificationRequired: true },
    { consumerGateControllerSha: sha },
  ])
    assert.throws(() => requireManagedInputs(managed(extra)));
});
test("binary and artifact authority use distinct exact publisher and gate contracts", () => {
  const binary = managed({
    autoAdmissionKind: "binary-release-assets",
    evidenceRepository: "kungfu-systems/buildchain",
    publisherWorkflowPath:
      ".github/workflows/.release-binary-assets.yml",
  });
  requireManagedInputs(binary);
  assert.throws(
    () =>
      requireManagedInputs({ ...binary, gateAggregateJson: "{}" }),
    /exactly one/,
  );
  assert.throws(
    () =>
      requireManagedInputs({
        ...binary,
        publisherWorkflowPath: ".github/workflows/other.yml",
      }),
    /sealed binary/,
  );
  requireManagedInputs(
    managed({ autoAdmissionKind: "publication-artifact" }),
  );
});
test("publication audits preserve literal inputs and provider-specific boundaries", () => {
 const input = { evidenceRepository: "acme/repo", buildchainRepository: "kungfu-systems/buildchain", targetRef: "alpha/v4/v4.1", sourceSha: sha, buildchainRef: sha,
  publisherWorkflowPath: ".github/workflows/publish.yml", requiredStatusCheck: "check", publicationVersion: "4.1.0-alpha.0", packageName: "$(touch /tmp/never)", publicationTarget: "npm:pkg" };
 const npm = publicationControlPlaneRequest({ ...input, autoAdmissionKind: "release-candidate" });
 assert.equal(npm.packageName, input.packageName);
 assert.equal(npm.publisherMode, "npm-trusted-publisher");
 const binary = publicationControlPlaneRequest({ ...input, autoAdmissionKind: "binary-release-assets" });
 assert.equal(binary.environment, "buildchain-release-assets");
 assert.equal(binary.allowReleaseReconciliation, true);
 assert.equal(binary.environmentRef, "v4.1.0-alpha.0");
 assert.equal(binary.environmentRefType, "tag");
 const github = publicationControlPlaneRequest({ ...input, autoAdmissionKind: "release-candidate", publicationTarget: "github-release:acme/repo" });
 assert.equal(github.publisherMode, "github-token");
 assert.throws(() => publicationControlPlaneRequest({ ...input, autoAdmissionKind: "unknown" }), /Unknown/);
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
    assert.equal(referencedControllerArtifact(path.dirname(dir)), "exact-controller");
    fs.writeFileSync(
      file,
      JSON.stringify({
        controllerReceipts: [{ artifact: "controller\nforged=value" }],
      }),
    );
    assert.throws(() => referencedControllerArtifact(path.dirname(dir)), /invalid/);
    fs.mkdirSync(path.join(dir, "duplicate"));
    fs.copyFileSync(
      file,
      path.join(dir, "duplicate", "release-candidate-passport.json"),
    );
    assert.throws(() => referencedControllerArtifact(path.dirname(dir)), /exactly one/);
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
    autoAdmissionKind: "release-candidate",
    publicationVersion: "4.1.0-alpha.0",
    consumerQualificationRequired: false,
  };
  const value = {
    runtimeSha: sha,
    version: env.publicationVersion,
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
          consumerQualificationRequired: true,
          consumerPredicateId: "expected",
        },
        sha,
      ),
    /predicate binding/,
  );
});
test("wrong authority checkout is rejected before GitHub evidence requests", async () => {
  let requests = 0;
  await assert.rejects(
    verifySealedAdmission({ request: { buildchainRef: sha }, runtimeRoot: "fixture", admission: { repository: "acme/project", sourceSha: sha } }, {
      verifyCheckout: () => { throw new Error("runtime checkout mismatch"); },
      tree: async () => { requests++; throw new Error("unexpected request"); },
    }),
    /runtime checkout mismatch/,
  );
  assert.equal(requests, 0);
});
test("dry-run has no publication authority and never invokes verification", () =>
 workspace(async root => {
  const outputs = await qualifyPublicationAuthority({ request: { dryRun: true }, workspace: root }, () => { throw new Error("dry-run attempted authority verification"); });
  assert.equal(JSON.parse(outputs["capability-json"]).decision, "dry-run");
  assert.equal(outputs["capability-digest"], "");
  assert.equal(outputs["gate-aggregate-json"], "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".buildchain/publication-authority/capability.json"), "utf8")).decision, "dry-run");
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
    fs.readFileSync("actions/publication/authority/admit/action.yml", "utf8"),
  );
  assert.ok(
    admit.runs.steps.findIndex(
      (s) => s.uses?.endsWith("/authority/inspect-request"),
    ) <
      admit.runs.steps.findIndex(
        (s) => s.name === "Checkout exact Buildchain authority runtime",
      ),
  );
  const candidate = YAML.parse(
    fs.readFileSync(
      "actions/publication/authority/candidate-evidence/action.yml",
      "utf8",
    ),
  );
  const gate = candidate.runs.steps.find((s) => s.id === "consumer-gate");
  assert.equal(gate.uses, "./.buildchain/authority-runtime/actions/publication/authority/qualify-consumer-gate");
  for (const name of ["admit", "candidate-evidence", "artifact-evidence", "verify"]) {
   const action = YAML.parse(fs.readFileSync(`actions/publication/authority/${name}/action.yml`, "utf8"));
   assert.ok(action.runs.steps.every(step => step.uses && !step.run && !step.shell));
  }
});
