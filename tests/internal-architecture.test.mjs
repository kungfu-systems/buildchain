import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  checkInternalArchitecture,
  repositoryJavaScriptFiles,
} from "../scripts/check-internal-architecture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const index = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture", "internal-capabilities.json"),
    "utf8",
  ),
);

test("internal architecture index covers implementations, tests, and dependency direction", () => {
  assert.deepEqual(checkInternalArchitecture({ root, index }), {
    schemaVersion: 1,
    capabilities: 17,
    implementations: 54,
    repositorySources: 285,
    ownedSources: 285,
    excludedSources: 0,
    dependencyEdges: 229,
    dependencyRules: 4,
    dependencyCycles: 0,
  });
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

  assert.deepEqual(repositoryJavaScriptFiles(temporaryRoot), [
    "new.mjs",
    "tracked.mjs",
  ]);
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
      "actions/promote-buildchain-ref/internal/promotion-policy.js",
      'import "../lib.js";\n',
    ],
  ]);
  assert.throws(
    () => checkInternalArchitecture({ root, index, sourceOverrides }),
    /promotion-internals-do-not-depend-on-facade.*actions\/promote-buildchain-ref\/lib\.js/s,
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

test("internal architecture check rejects dependency cycles", () => {
  const sourceOverrides = new Map([
    [
      "actions/promote-buildchain-ref/internal/promotion-policy.js",
      'import "./version-state.js";\n',
    ],
    [
      "actions/promote-buildchain-ref/internal/version-state.js",
      'import "./promotion-policy.js";\n',
    ],
  ]);
  assert.throws(
    () => checkInternalArchitecture({ root, index, sourceOverrides }),
    /internal dependency cycle: .*promotion-policy\.js.*version-state\.js/s,
  );
});
