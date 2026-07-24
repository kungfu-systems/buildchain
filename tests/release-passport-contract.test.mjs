import assert from "node:assert/strict";
import test from "node:test";
import { createReleasePassport } from "../packages/core/release-passport.js";
import {
  RELEASE_PASSPORT_CHECK_MANIFEST_CONTRACT,
  RELEASE_PASSPORT_SCHEMA,
  RELEASE_PASSPORT_SCHEMA_ID,
  createReleasePassportCheckManifest,
  validateReleasePassportSchema,
} from "../packages/core/release-passport-contract.js";

test("standalone release passport schema accepts a generated Buildchain passport", () => {
  const passport = createReleasePassport({
    repository: "kungfu-systems/buildchain",
    tag: "v2.14.3-alpha.1",
    sourceSha: "a".repeat(40),
    assets: [{ name: "buildchain.tgz", sha256: "b".repeat(64) }],
  });
  const report = validateReleasePassportSchema(passport);

  assert.equal(RELEASE_PASSPORT_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(RELEASE_PASSPORT_SCHEMA.$id, RELEASE_PASSPORT_SCHEMA_ID);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("standalone release passport schema fails closed on an incomplete envelope", () => {
  const report = validateReleasePassportSchema({
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport",
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.filter((entry) => entry.code === "required").map((entry) => entry.pointer),
    ["#/product", "#/release", "#/artifacts", "#/evidence", "#/recovery"],
  );
});

test("release passport check manifest declares closure, ownership, and compatibility", () => {
  const manifest = createReleasePassportCheckManifest();

  assert.equal(manifest.contract, RELEASE_PASSPORT_CHECK_MANIFEST_CONTRACT);
  assert.equal(manifest.passport.schema.id, RELEASE_PASSPORT_SCHEMA_ID);
  assert.equal(manifest.passport.checker.command, "buildchain verify release-passport <buildchain.release.json>");
  assert.deepEqual(manifest.localClosure.requiredSiblings, [
    "product.mechanism",
    "evidence.artifactEvidence",
    "evidence.impact",
    "evidence.agentIndex",
  ]);
  assert.ok(manifest.ownership.aggregationFields.includes("packageSet"));
  assert.deepEqual(manifest.ownership.kfdSections.map((entry) => entry.section), ["kfd-1", "kfd-2", "kfd-3"]);
  assert.ok(manifest.ownership.kfdSections.every((entry) => entry.owner === "KFD"));
  assert.match(manifest.compatibility.envelope, /optional fields may be added/);
  assert.match(manifest.compatibility.kfdSections, /@kungfu-tech\/kfd/);
});
