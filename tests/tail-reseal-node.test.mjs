import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { verifyTailPolicyBindings } from "../packages/core/release/reseal/admission.js";
import { verifyResealProviderReadbacks } from "../packages/core/release/reseal/readbacks.js";
import { publicationLine } from "../packages/core/release/reseal/seal.js";
import { tailResealFixturePolicyReceipt } from "../scripts/generate-tail-reseal-fixture.mjs";
const repositoryRoot = path.resolve(import.meta.dirname, "..");
function bindings() {
  const read = file => JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), "utf8"));
  const request = read("contracts/fixtures/v4-tail-reseal-v1/valid.json");
  const { receipt, receiptRoot } = tailResealFixturePolicyReceipt(request, read("architecture/floating-consumer-policy.json"));
  request.runtime.consumerPolicyReceiptRoot = receiptRoot;
  return { request, receipt, sourceSha: request.source.sha, runtimeSha: request.runtime.sha };
}
test("tail policy admission binds source, runtime and the existing rooted consumer receipt", () => {
  assert.doesNotThrow(() => verifyTailPolicyBindings(bindings()));
  for (const key of ["sourceSha", "runtimeSha"]) {
    const input = bindings(); input[key] = input[key] === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    assert.throws(() => verifyTailPolicyBindings(input), /differs/);
  }
  const input = bindings(); input.request.runtime.consumerPolicyReceiptRoot = `sha256:${"f".repeat(64)}`;
  assert.throws(() => verifyTailPolicyBindings(input), /Consumer policy receipt invalid/);
});
test("both independent provider readbacks must match their exact byte roots", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tail-readbacks-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const digest = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
  fs.writeFileSync(path.join(directory, "signing-provider-readback.json"), "signing");
  fs.writeFileSync(path.join(directory, "release-tail-provider-readback.json"), "tail");
  const request = { directory, signingRoot: digest("signing"), releaseTailRoot: digest("tail") };
  assert.doesNotThrow(() => verifyResealProviderReadbacks(request));
  for (const key of ["signingRoot", "releaseTailRoot"]) assert.throws(() => verifyResealProviderReadbacks({ ...request, [key]: digest("tampered") }), /root mismatch/);
});
test("tail publication line derives from the exact version and rejects unsealed selectors", () => {
  assert.equal(publicationLine("4.1.0-alpha.0"), "alpha/v4/v4.1");
  assert.equal(publicationLine("5.2.3-alpha.4"), "alpha/v5/v5.2");
  for (const value of ["4.1.0", "v4-alpha", "4.1.0-beta.1", ""]) assert.throws(() => publicationLine(value), /exact alpha/);
});
test("tail composites use business actions and keep signing credentials in platform finalization", () => {
  const read = phase => YAML.parse(fs.readFileSync(path.join(repositoryRoot, `actions/release/reseal/${phase}/action.yml`), "utf8"));
  for (const phase of ["plan", "platforms", "seal"]) for (const step of read(phase).runs.steps) {
    assert.ok(step.uses); assert.equal(step.run, undefined); assert.equal(step.shell, undefined);
  }
  const steps = read("platforms").runs.steps;
  assert.deepEqual(steps.filter(step => step.with?.["signing-token"]).map(step => step.uses), ["./.buildchain/runtime/actions/release/reseal/finalize-platform"]);
  for (const phase of ["plan", "seal"]) assert.doesNotMatch(JSON.stringify(read(phase)), /signing-token/);
});
