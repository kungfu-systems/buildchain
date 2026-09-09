import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  checkInternalArchitecture,
  repositorySourceFiles,
} from "../scripts/check-internal-architecture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const index = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture", "internal-capabilities.json"),
    "utf8",
  ),
);

test("internal architecture index covers implementations, tests, and dependency direction", () => {
  const report = checkInternalArchitecture({ root });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.ownedSources, report.repositorySources);
  assert.equal(report.excludedSources, 0);
  assert.equal(report.dependencyCycles, 0);
  assert.ok(report.implementations > 0 && report.dependencyEdges > 0);

});

test("repository source inventory includes untracked files before commit", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-architecture-untracked-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: temporaryRoot });
  fs.writeFileSync(path.join(temporaryRoot, "tracked.mjs"), "export {};\n");
  execFileSync("git", ["add", "tracked.mjs"], { cwd: temporaryRoot });
  fs.writeFileSync(path.join(temporaryRoot, "new.mjs"), "export {};\n");

  assert.deepEqual(repositorySourceFiles(temporaryRoot), [
    "new.mjs",
    "tracked.mjs",
  ]);
});

test("repository source inventory excludes transient root test sandboxes", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-architecture-transient-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: temporaryRoot });
  fs.mkdirSync(path.join(temporaryRoot, ".tmp-fixture"));
  fs.writeFileSync(
    path.join(temporaryRoot, ".tmp-fixture", "fixture.cjs"),
    "module.exports = {};\n",
  );

  assert.deepEqual(repositorySourceFiles(temporaryRoot), []);
});

test("downloaded runtime bootstrap copies are ignored while project source remains inventoried", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-bootstrap-inventory-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: temporaryRoot });
  fs.copyFileSync(
    path.join(root, ".gitignore"),
    path.join(temporaryRoot, ".gitignore"),
  );
  fs.mkdirSync(path.join(temporaryRoot, ".buildchain/runtime-bootstrap"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(
      temporaryRoot,
      ".buildchain/runtime-bootstrap/locked-source-checkout.mjs",
    ),
    "export {};\n",
  );
  fs.writeFileSync(path.join(temporaryRoot, "project.mjs"), "export {};\n");
  assert.deepEqual(repositorySourceFiles(temporaryRoot), ["project.mjs"]);
});

test("internal architecture check rejects an unowned repository source", () => {
  const unowned = structuredClone(index);
  unowned.ownershipRules = unowned.ownershipRules.filter(
    (entry) => entry.id !== "cli-sources",
  );
  assert.throws(
    () => checkInternalArchitecture({ root, index: unowned }),
    /repository source has no owner: bin\/buildchain\.mjs/,
  );
});

test("internal architecture check rejects an internal-to-facade dependency", () => {
  const sourceOverrides = new Map([
    [
      "packages/core/release/promote-ref/internal/promotion-policy.js",
      'import "../lib.js";\n',
    ],
  ]);
  assert.throws(
    () => checkInternalArchitecture({ root, index, sourceOverrides }),
    /promotion-internals-do-not-depend-on-facade.*packages\/core\/release\/promote-ref\/lib\.js/s,
  );
});

test("internal architecture check rejects a capability without regression tests", () => {
  const missingTests = structuredClone(index);
  missingTests.capabilities[0].tests = [];
  assert.throws(
    () => checkInternalArchitecture({ root, index: missingTests }),
    /promotion-policy: test mapping is empty/,
  );
});

test("internal architecture check requires generated-output mappings", () => {
  const missingOutputs = structuredClone(index);
  delete missingOutputs.capabilities[0].generatedOutputs;
  assert.throws(
    () => checkInternalArchitecture({ root, index: missingOutputs }),
    /promotion-policy: generated output mapping is missing/,
  );
});

test("internal architecture check requires minimal validation commands", () => {
  const missingValidation = structuredClone(index);
  missingValidation.capabilities[0].validationCommands = [];
  assert.throws(
    () => checkInternalArchitecture({ root, index: missingValidation }),
    /promotion-policy: validation command mapping is empty/,
  );
});

test("internal architecture check rejects dependency cycles", () => {
  const sourceOverrides = new Map([
    [
      "packages/core/release/promote-ref/internal/promotion-policy.js",
      'import "../../version-state.js";\n',
    ],
    [
      "packages/core/release/version-state.js",
      'import "./promote-ref/internal/promotion-policy.js";\n',
    ],
  ]);
  assert.throws(
    () => checkInternalArchitecture({ root, index, sourceOverrides }),
    /internal dependency cycle: .*promotion-policy\.js.*version-state\.js/s,
  );
});
