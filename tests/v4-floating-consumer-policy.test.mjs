import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  certifyV4FloatingConsumerPolicyReceipt,
  scanV4FloatingConsumerPolicy,
  verifyV4FloatingConsumerPolicyReceipt,
} from "../packages/core/v4-floating-consumer-policy.js";
import {
  createReleaseCandidatePassport,
  validateReleaseCandidatePassport,
} from "../packages/core/release-candidate.js";
import { createReleasePassport } from "../packages/core/release-passport.js";
import { parseYamlUses } from "../packages/core/workflow-yaml-contract.js";

const root = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/v4-floating-consumer-policy.json"),
    "utf8",
  ),
);
const schema = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      "contracts/v4-floating-consumer-policy-receipt-v1.schema.json",
    ),
    "utf8",
  ),
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      "contracts/fixtures/v4-floating-consumer-policy-v1/cases.json",
    ),
    "utf8",
  ),
);
const SOURCE_SHA = "b".repeat(40);
const STABLE_SHA = "c".repeat(40);
const ALPHA_SHA = "d".repeat(40);
const ROOT = `sha256:${"e".repeat(64)}`;

function lock(ref, resolvedSha) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-contract-lock",
    buildchain: {
      ref,
      resolvedSha,
      contract: "kungfu-buildchain-runtime-contract-world",
      contractDigest: ROOT,
      compatibilityDigest: ROOT,
      majorLine: "v4",
      compatibilityPolicy: "major-compatible",
      acceptedAt: "2026-08-14T00:00:00.000Z",
      surfaces: [],
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function workspace(fixture) {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-floating-policy-"),
  );
  const workflowPath = path.join(destination, ".github/workflows/build.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  if (fixture.selector === "local-composite") {
    fs.writeFileSync(
      workflowPath,
      "jobs:\n  build:\n    steps:\n      - uses: ./.github/actions/wrapper\n",
    );
    const actionPath = path.join(
      destination,
      ".github/actions/wrapper/action.yml",
    );
    fs.mkdirSync(path.dirname(actionPath), { recursive: true });
    fs.writeFileSync(
      actionPath,
      `name: wrapper\nruns:\n  using: composite\n  steps:\n    - uses: kungfu-systems/buildchain/actions/run-lifecycle@${"a".repeat(40)}\n`,
    );
  } else {
    fs.writeFileSync(
      workflowPath,
      `jobs:\n  build:\n    uses: kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml@${fixture.selector}\n`,
    );
  }
  writeJson(
    path.join(destination, ".buildchain/contract-lock.json"),
    lock("v4", STABLE_SHA),
  );
  writeJson(
    path.join(destination, ".buildchain/alpha-contract-lock.json"),
    lock("v4-alpha", ALPHA_SHA),
  );
  if (fixture.stale === "alpha") {
    writeJson(
      path.join(destination, ".buildchain/alpha-contract-lock.json"),
      lock("v4-alpha", "f".repeat(40)),
    );
  }
  if (fixture.remove) fs.rmSync(path.join(destination, fixture.remove));
  return destination;
}

function evaluate(fixture) {
  const selectedSha = fixture.selector === "v4-alpha" ? ALPHA_SHA : STABLE_SHA;
  return scanV4FloatingConsumerPolicy({
    root: workspace(fixture),
    repository: "kungfu-systems/consumer",
    sourceSha: SOURCE_SHA,
    invokedWorkflow: "v4-stage-capsule-canary.yml",
    resolvedRuntimeSha: selectedSha,
    policy,
    scannerRoot: ROOT,
  });
}

test("shared YAML semantic layer ignores uses-like text inside run blocks", () => {
  const nodes = parseYamlUses(
    `jobs:\n  check:\n    steps:\n      - run: |\n          echo "uses: kungfu-systems/buildchain/x@${"a".repeat(40)}"\n      - uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4\n`,
  );
  assert.deepEqual(
    nodes.map((entry) => entry.value),
    ["kungfu-systems/buildchain/.github/workflows/build.yml@v4"],
  );
});

for (const fixture of fixtures.cases) {
  test(`v4 floating consumer policy fixture: ${fixture.id}`, () => {
    const result = evaluate(fixture);
    if (fixture.expected === "passed") {
      assert.equal(result.ok, true, JSON.stringify(result.failures));
      assert.equal(result.receipt.invocation.selectorClass, "floating");
      assert.equal(result.receipt.failures.length, 0);
      const validate = new Ajv2020({ strict: false }).compile(schema);
      assert.equal(
        validate(result.receipt),
        true,
        JSON.stringify(validate.errors),
      );
      return;
    }
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((failure) => failure.code === fixture.expectedCode),
      JSON.stringify(result.failures),
    );
  });
}

test("receipt verification and external certification fail closed on stale roots", () => {
  const result = evaluate(fixtures.cases[0]);
  const verified = verifyV4FloatingConsumerPolicyReceipt({
    receipt: result.receipt,
    receiptRoot: result.receiptRoot,
    repository: "kungfu-systems/consumer",
    sourceSha: SOURCE_SHA,
    invokedWorkflow: "v4-stage-capsule-canary.yml",
    resolvedRuntimeSha: STABLE_SHA,
  });
  assert.equal(verified.ok, true);
  const certified = certifyV4FloatingConsumerPolicyReceipt({
    receipt: result.receipt,
    receiptRoot: result.receiptRoot,
    sourceSha: "f".repeat(40),
  });
  assert.equal(certified.ok, false);
  assert.equal(certified.certification.status, "rejected");
  assert.ok(
    certified.verification.failures.some(
      (failure) => failure.code === "caller-source-mismatch",
    ),
  );
});

test("an old Buildchain runtime cannot self-authorize without a rooted receipt", () => {
  const certification = certifyV4FloatingConsumerPolicyReceipt({
    receipt: undefined,
    receiptRoot: "",
    repository: "kungfu-systems/consumer",
    sourceSha: SOURCE_SHA,
    invokedWorkflow: "v4-stage-capsule-canary.yml",
    resolvedRuntimeSha: STABLE_SHA,
  });
  assert.equal(certification.ok, false);
  assert.ok(
    certification.verification.failures.some(
      (failure) => failure.code === "receipt-contract-invalid",
    ),
  );
});

test("v4 release candidate passports require and hash the source/runtime-bound receipt", () => {
  const result = evaluate(fixtures.cases[0]);
  const input = {
    repository: "kungfu-systems/consumer",
    targetChannel: "alpha",
    version: "4.0.0-alpha.1",
    sourceHeadSha: SOURCE_SHA,
    sourceTreeHash: "a".repeat(40),
    buildchain: { ref: "v4", sha: STABLE_SHA, workflowShellRef: "v4" },
    consumerPolicyReceipt: {
      receipt: result.receipt,
      receiptRoot: result.receiptRoot,
    },
    buildSummary: {
      contract: "kungfu-buildchain-build-summary",
      git: {
        repository: "kungfu-systems/consumer",
        sha: SOURCE_SHA,
        treeSha: "a".repeat(40),
      },
      platforms: [
        { artifactName: "consumer-linux", platform: { id: "linux-x64" } },
      ],
    },
  };
  assert.throws(
    () =>
      createReleaseCandidatePassport({
        ...input,
        consumerPolicyReceipt: undefined,
      }),
    /requires a valid floating consumer policy receipt/u,
  );
  const passport = createReleaseCandidatePassport(input);
  assert.equal(validateReleaseCandidatePassport({ passport }).ok, true);
  passport.consumerPolicy.receipt.invocation.resolvedRuntimeSha = "f".repeat(
    40,
  );
  const validation = validateReleaseCandidatePassport({ passport });
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((message) =>
      message.includes("runtime-sha-mismatch"),
    ),
  );
  assert.ok(validation.errors.includes("candidate hash mismatch"));
});

test("final v4 Release Passport construction requires fresh external certification", () => {
  const result = evaluate(fixtures.cases[0]);
  const certification = certifyV4FloatingConsumerPolicyReceipt({
    receipt: result.receipt,
    receiptRoot: result.receiptRoot,
    repository: "kungfu-systems/consumer",
    sourceSha: SOURCE_SHA,
    resolvedRuntimeSha: STABLE_SHA,
  });
  const promotionRouting = {
    contract: "buildchain.promotion-routing/v1",
    router: { ref: "v4", sha: STABLE_SHA },
    shell: { ref: "v4", sha: STABLE_SHA },
    runtime: { requestedRef: "v4", resolvedSha: STABLE_SHA },
    contractLock: { path: ".buildchain/contract-lock.json", digest: ROOT },
    publication: { channel: "release", targetRef: "release/v4/v4.0" },
  };
  const input = {
    repository: "kungfu-systems/consumer",
    tag: "v4.0.0",
    sourceSha: SOURCE_SHA,
    release: { promotionRouting },
  };
  assert.throws(
    () => createReleasePassport(input),
    /requires an external floating consumer policy certification/u,
  );
  const passport = createReleasePassport({
    ...input,
    v4ConsumerPolicyCertification: certification,
  });
  assert.equal(passport.v4ConsumerPolicy.certification.status, "certified");
  assert.throws(
    () =>
      createReleasePassport({
        ...input,
        v4ConsumerPolicyCertification: {
          ...certification,
          certificationRoot: `sha256:${"f".repeat(64)}`,
        },
      }),
    /certification-root-mismatch/u,
  );
});
