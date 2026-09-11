import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import Ajv2020 from "ajv/dist/2020.js";

import { normalizeBuildchainConfig } from "../packages/core/consumer/buildchain-config.js";
import { loadPublishedBuildchainDeliveryAuthority } from "../packages/core/dev-delivery/published-delivery-authority.js";
import {
  runAdopterDeliveryGate,
  verifyAdopterDeliveryReadback,
} from "../packages/core/adoption/adopter-delivery.js";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(root, "contracts/fixtures/v4-adopter-delivery-v1");
const positive = JSON.parse(
  fs.readFileSync(path.join(fixtures, "gate-positive.json"), "utf8"),
);

test("public Adopter Delivery uses one closed JSON request", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/v4-adopter-delivery-v1.schema.json"),
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(positive), true, JSON.stringify(validate.errors));
  for (const field of ["driverSelector", "artifactProfileSelector"]) {
    assert.throws(
      () => runAdopterDeliveryGate({ ...positive, [field]: "private" }),
      /unknown .*selector/,
    );
  }
  assert.throws(
    () => normalizeBuildchainConfig({ schema: 1, adopter_delivery: {} }),
    /closed JSON request/,
  );
});

test("retired KFD adapter cannot be selected or exported", () => {
  const input = structuredClone(positive);
  input.driverSelector = "legacy-kfd";
  assert.throws(
    () => runAdopterDeliveryGate(input),
    /unknown driver selector/u,
  );
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(
    Object.hasOwn(pkg.exports, "./legacy-kfd-adopter-driver"),
    false,
  );
});

test("public driver run and exact readback are deterministic and fail closed", () => {
  const readback = runAdopterDeliveryGate(positive);
  assert.equal(readback.gateResult.status, "passed");
  assert.equal(readback.releaseAuthorized, false);
  assert.deepEqual(
    verifyAdopterDeliveryReadback({ input: positive, readback }),
    readback,
  );

  const tampered = structuredClone(readback);
  tampered.gateResult.artifact.root = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () =>
      verifyAdopterDeliveryReadback({ input: positive, readback: tampered }),
    /does not match exact recomputation/,
  );
  const unknown = JSON.parse(
    fs.readFileSync(path.join(fixtures, "gate-unknown-selector.json"), "utf8"),
  );
  assert.throws(
    () => runAdopterDeliveryGate(unknown),
    /unknown driver selector/,
  );
  const version = structuredClone(positive);
  version.request.protocol.version = "2.0.0";
  assert.throws(
    () => runAdopterDeliveryGate(version),
    /does not match the exact request protocol/,
  );
  assert.throws(
    () => verifyAdopterDeliveryReadback({ input: positive }),
    /readback is required/,
  );
});

test("CLI and public self-dogfood workflow expose the same public boundary", () => {
  const completed = spawnSync(
    process.execPath,
    [
      "bin/buildchain.mjs",
      "adopter-delivery",
      "run",
      "--input",
      path.join(fixtures, "gate-positive.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).gateResult.status, "passed");

  const caller = fs.readFileSync(
    path.join(root, ".github/workflows/self-build-adopter-dogfood.yml"),
    "utf8",
  );
  assert.match(
    caller,
    /kungfu-systems\/buildchain\/\.github\/workflows\/public-build-adopter-qualification\.yml@v4/,
  );
  assert.doesNotMatch(caller, /(?:uses:\s*\.\/|runs-on:|steps:|BUILDCHAIN_)/);
});

test("candidate dispatch binds an external adopter through the admitted source output", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      path.join(
        root,
        ".github/workflows/public-build-adopter-qualification.yml",
      ),
      "utf8",
    ),
  );
  for (const trigger of ["workflow_call", "workflow_dispatch"]) {
    for (const input of [
      "consumer-repository",
      "consumer-ref",
      "invocation-source-path",
    ])
      assert.ok(workflow.on[trigger].inputs[input]);
    for (const removed of ["bootstrap-path", "archive-path"])
      assert.equal(Object.hasOwn(workflow.on[trigger].inputs, removed), false);
  }
  assert.equal(
    workflow.jobs.conformance.steps[1].with["consumer-sha"],
    "${{ needs.consumer-admission.outputs.consumer-source-sha }}",
  );
  assert.equal(
    workflow.jobs["consumer-admission"].steps[1].uses,
    "./.buildchain/runtime/actions/adoption/adopter/admit",
  );
});
