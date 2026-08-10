import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  V4_PUBLIC_DOGFOOD_TRAIN_REF,
  checkV4PublicDogfoodContract,
  expectedV4PublicDogfoodWorkflow,
} from "../scripts/check-v4-public-dogfood-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixturePaths = [
  ".buildchain/buildchain.toml",
  ".github/workflows",
  "AGENTS.md",
  "architecture/v4-stage-capsule-qualification.json",
  "docs/v4-stage-capsule.md",
  "package.json",
  "packages/core/v4-stage-capsule-qualification-campaign.js",
  "packages/core/v4-stage-capsule-qualification.js",
  "scripts/v4-stage-capsule-qualification.mjs",
];

function fixture() {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-public-dogfood-contract-"),
  );
  for (const relative of fixturePaths) {
    const source = path.join(root, relative);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  return destination;
}

function mutate(relative, transform) {
  const targetRoot = fixture();
  const file = path.join(targetRoot, relative);
  fs.writeFileSync(file, transform(fs.readFileSync(file, "utf8")));
  return targetRoot;
}

test("the tracked v4 dogfood path is one thin public consumer caller", () => {
  assert.deepEqual(checkV4PublicDogfoodContract(root), {
    schema: "buildchain-v4-public-dogfood-contract-check/v1",
    ok: true,
    caller: ".github/workflows/v4-public-consumer-dogfood.yml",
    reusable: ".github/workflows/v4-stage-capsule-canary.yml",
    validationRef: V4_PUBLIC_DOGFOOD_TRAIN_REF,
    productionAuthority: "v3",
  });
});

test("the gate rejects copied orchestration and relative reusable calls", () => {
  const copied = mutate(
    ".github/workflows/v4-public-consumer-dogfood.yml",
    (text) => `${text}\n    steps:\n      - run: echo bypass\n`,
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(copied),
    /exact thin public consumer caller/u,
  );

  const relative = mutate(
    ".github/workflows/v4-public-consumer-dogfood.yml",
    (text) =>
      text.replace(
        "kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml@",
        "./.github/workflows/v4-stage-capsule-canary.yml#",
      ),
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(relative),
    /exact thin public consumer caller/u,
  );
});

test("the gate rejects a second private workflow or direct qualification job", () => {
  const targetRoot = fixture();
  fs.writeFileSync(
    path.join(targetRoot, ".github/workflows/v4-private-candidate.yml"),
    "jobs:\n  bypass:\n    steps:\n      - run: node scripts/v4-stage-capsule-qualification.mjs\n",
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(targetRoot),
    /invokes the private qualification script directly/u,
  );
});

test("the gate permits only the public train or an exact protected SHA", () => {
  const feature = mutate(
    "architecture/v4-stage-capsule-qualification.json",
    (text) =>
      text.replace(V4_PUBLIC_DOGFOOD_TRAIN_REF, "feature/private-candidate"),
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(feature),
    /exact public train or a protected commit SHA/u,
  );

  const exactRoot = fixture();
  const protectedSha = "a".repeat(40);
  const architecturePath = path.join(
    exactRoot,
    "architecture/v4-stage-capsule-qualification.json",
  );
  fs.writeFileSync(
    architecturePath,
    fs
      .readFileSync(architecturePath, "utf8")
      .replace(V4_PUBLIC_DOGFOOD_TRAIN_REF, protectedSha),
  );
  fs.writeFileSync(
    path.join(exactRoot, ".github/workflows/v4-public-consumer-dogfood.yml"),
    expectedV4PublicDogfoodWorkflow(protectedSha),
  );
  assert.equal(
    checkV4PublicDogfoodContract(exactRoot).validationRef,
    protectedSha,
  );
});

test("the gate rejects legacy profiles and removal from protected Verify", () => {
  const legacy = mutate(
    "packages/core/v4-stage-capsule-qualification-campaign.js",
    (text) => `${text}\n// ${["buildchain", "self", "dogfood"].join("-")}\n`,
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(legacy),
    /retains private marker/u,
  );

  const unprotected = mutate(".github/workflows/verify.yml", (text) =>
    text.replace(
      "run: node scripts/check-v4-public-dogfood-contract.mjs",
      "run: true",
    ),
  );
  assert.throws(
    () => checkV4PublicDogfoodContract(unprotected),
    /Verify is missing protected gate/u,
  );
});
