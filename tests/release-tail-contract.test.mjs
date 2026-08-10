import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { checkReleaseTailContract } from "../scripts/check-release-tail-contract.mjs";

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function inventory() {
  return load("architecture/release-tail-contract-inventory.json");
}

function fixture() {
  return load(
    "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
  );
}

test("release-tail inventory closes commands, callers, and declarative capabilities", () => {
  const report = checkReleaseTailContract();
  assert.deepEqual(report, {
    surfaces: 7,
    managedCallers: 7,
    capabilities: 4,
    coordinates: 27,
    executionSites: 9,
  });
});

test("reverse scan rejects an unclassified or multiply owned production hook", () => {
  const value = inventory();
  value.legacyExecutableSurfaces[0].coordinates =
    value.legacyExecutableSurfaces[0].coordinates.filter(
      (entry) => !entry.endsWith("#publication-gate-command"),
    );
  assert.throws(
    () => checkReleaseTailContract({ inventory: value }),
    /unclassified release-tail command surface/u,
  );

  const ambiguous = inventory();
  ambiguous.legacyExecutableSurfaces[1].coordinates.push(
    ambiguous.legacyExecutableSurfaces[0].coordinates[0],
  );
  assert.throws(
    () => checkReleaseTailContract({ inventory: ambiguous }),
    /ambiguous surface ownership/u,
  );
});

test("declarations reject embedded commands and incomplete operation identity", () => {
  const embedded = fixture();
  embedded.capabilities[0].command = "npm publish";
  assert.throws(
    () =>
      checkReleaseTailContract({
        inventory: inventory(),
        fixtures: { "embedded-command.json": embedded },
      }),
    /executable key is forbidden/u,
  );

  const unidentified = fixture();
  unidentified.capabilities[0].operationIdentity.subjectRoot = "latest";
  assert.throws(
    () =>
      checkReleaseTailContract({
        inventory: inventory(),
        fixtures: { "unidentified-effect.json": unidentified },
      }),
    /operation identity is incomplete/u,
  );
});

test("declarations reject missing readback and unbounded local retry", () => {
  const noReadback = fixture();
  noReadback.capabilities[1].readbackPredicates = [];
  assert.throws(
    () =>
      checkReleaseTailContract({
        inventory: inventory(),
        fixtures: { "missing-readback.json": noReadback },
      }),
    /has no readback predicate/u,
  );

  const unbounded = fixture();
  unbounded.capabilities[2].retry.localAttempts = 99;
  assert.throws(
    () =>
      checkReleaseTailContract({
        inventory: inventory(),
        fixtures: { "unbounded-retry.json": unbounded },
      }),
    /local retry is invalid/u,
  );
});

test("migration rejects permanent escape hatches and unowned exceptions", () => {
  const escape = inventory();
  escape.migration.compatibilityWindow.permanentEscapeHatch = true;
  escape.migration.exceptionLedger = [];
  assert.throws(
    () => checkReleaseTailContract({ inventory: escape }),
    /compatibility window is not bounded|compatibility exception has no owner/u,
  );
});
