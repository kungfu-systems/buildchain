import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";

import {
  PUBLIC_DOGFOOD_ENTRY_REF,
  checkPublicDogfoodContract,
} from "../scripts/check-public-dogfood-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const protectedDogfoodRef = PUBLIC_DOGFOOD_ENTRY_REF;
const fixturePaths = [
  "actions/build/verification/repository",
  "architecture/workflow-taxonomy.json",
  "actions/build/stage-capsule",
  "packages/core/build/stage-capsule/actions.js",
  "packages/core/build/stage-capsule/canary.js",
  "packages/core/build/verification/source.js",
  ".buildchain/buildchain.toml",
  "scripts/verify-product-platform.mjs",
  ".gitattributes",
  ".github/workflows",
  "AGENTS.md",
  "architecture/stage-capsule-qualification.json",
  "docs/v4-stage-capsule.md",
  "package.json",
  "packages/core/build/stage-capsule-qualification-campaign.js",
  "packages/core/build/stage-capsule-qualification.js",
  "packages/core/build/commands/stage-capsule-qualification.mjs",
];

function fixture() {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-public-dogfood-contract-"),
  );
  for (const relative of fixturePaths) {
    const source = path.join(root, relative);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      filter: (file) => !file.split(path.sep).includes("dist"),
    });
  }
  for (const [file, bytes] of Object.entries(consumerWorkflows()))
    fs.writeFileSync(path.join(destination, file), bytes);
  return destination;
}

function mutate(relative, transform) {
  const targetRoot = fixture();
  const file = path.join(targetRoot, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  assert.notEqual(
    after,
    before,
    "test mutation must change the exercised source",
  );
  fs.writeFileSync(file, after);
  return targetRoot;
}

test("the tracked v4 dogfood path is one thin public consumer caller", () => {
  assert.deepEqual(checkPublicDogfoodContract(root), {
    schema: "buildchain-v4-public-dogfood-contract-check/v1",
    ok: true,
    caller: ".github/workflows/buildchain.yml",
    reusable: ".github/workflows/public-ops-pipeline.yml",
    historicalCanary: ".github/workflows/.build-stage-capsule-canary.yml",
    validationRef: protectedDogfoodRef,
    productionAuthority: "v4-native",
  });
});

test("the gate rejects copied orchestration and relative reusable calls", () => {
  const copied = mutate(
    ".github/workflows/buildchain.yml",
    (text) => `${text}\n    steps:\n      - run: echo bypass\n`,
  );
  assert.throws(
    () => checkPublicDogfoodContract(copied),
    /generated caller drift/u,
  );

  const relative = mutate(".github/workflows/buildchain.yml", (text) =>
    text.replace(
      "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@",
      "./.github/workflows/public-ops-pipeline.yml#",
    ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(relative),
    /generated caller drift/u,
  );
});

test("self qualification accepts the shared Alpha caller pair", () => {
  const target = fixture();
  for (const [file, bytes] of Object.entries(consumerWorkflows("v4-alpha")))
    fs.writeFileSync(path.join(target, file), bytes);
  assert.equal(checkPublicDogfoodContract(target).ok, true);
  const normal = ".github/workflows/buildchain.yml";
  fs.writeFileSync(path.join(target, normal), consumerWorkflows()[normal]);
  assert.throws(
    () => checkPublicDogfoodContract(target),
    /generated caller drift/u,
  );
});

test("self callers reject mixed channels and the retired transition config", () => {
  for (const [before, after] of [
    ["public-ops-pipeline.yml@v4\n", "public-ops-pipeline.yml@v4-alpha\n"],
    [
      "    secrets: inherit",
      "    with:\n      config-path: .buildchain/alternate.toml\n    secrets: inherit",
    ],
  ]) {
    const target = mutate(".github/workflows/buildchain.yml", (text) =>
      text.replace(before, after),
    );
    assert.throws(
      () => checkPublicDogfoodContract(target),
      /generated caller drift/u,
    );
  }
  const duplicate = fixture();
  fs.copyFileSync(
    path.join(duplicate, ".buildchain/buildchain.toml"),
    path.join(duplicate, ".buildchain/minimal-consumer.toml"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(duplicate),
    /retired transition config/u,
  );
});

test("the consumer pair cannot hide another event controller in a product library", () => {
  const target = mutate(".github/workflows/public-ops-pipeline.yml", (text) =>
    text.replace("  workflow_call:", "  push:\n  workflow_call:"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(target),
    /product library owns a repository event/u,
  );
});

test("product verification cannot replace checkpoint recovery or hide publication commands", () => {
  const checkpoint = mutate("scripts/verify-product-platform.mjs", (text) =>
    text.replace("verifyStageCapsuleCheckpoints({", "skipCheckpoints({"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(checkpoint),
    /retain checkpoint recovery/u,
  );
  const container = mutate("scripts/verify-product-platform.mjs", (text) =>
    text.replace('"--network=none"', '"--network=host"'),
  );
  assert.throws(
    () => checkPublicDogfoodContract(container),
    /isolated container backbone lane/u,
  );
  const publication = mutate(".buildchain/buildchain.toml", (text) =>
    text.replace('"node scripts/build-standalone-binary.mjs"', '"npm publish"'),
  );
  assert.throws(
    () => checkPublicDogfoodContract(publication),
    /consumer-owned publication orchestration/u,
  );
});

test("the gate rejects a second private workflow or direct qualification job", () => {
  const targetRoot = fixture();
  fs.writeFileSync(
    path.join(targetRoot, ".github/workflows/v4-private-candidate.yml"),
    "jobs:\n  bypass:\n    steps:\n      - run: node packages/core/build/commands/stage-capsule-qualification.mjs\n",
  );
  assert.throws(
    () => checkPublicDogfoodContract(targetRoot),
    /invokes the private qualification script directly/u,
  );
});

test("the gate requires the public v4 entry", () => {
  const feature = mutate(
    "architecture/stage-capsule-qualification.json",
    (text) => {
      const value = JSON.parse(text);
      value.publicConsumerDogfood.validationRef = "feature/private-candidate";
      return JSON.stringify(value);
    },
  );
  assert.throws(
    () => checkPublicDogfoodContract(feature),
    /public|floating|validation/u,
  );
});

test("the gate rejects legacy profiles and removal from protected Verify", () => {
  const legacy = mutate(
    "packages/core/build/stage-capsule-qualification-campaign.js",
    (text) => `${text}\n// ${["buildchain", "self", "dogfood"].join("-")}\n`,
  );
  assert.throws(
    () => checkPublicDogfoodContract(legacy),
    /retains private marker/u,
  );

  const unprotected = mutate(
    "packages/core/build/verification/source.js",
    (text) => text.replaceAll("qualifySourceLifecycle", "unqualifiedLifecycle"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(unprotected),
    /Verify is missing protected gate/u,
  );
});

test("the gate requires build to use public scripts and refresh verify outputs", () => {
  const incompleteBuild = mutate(".buildchain/buildchain.toml", (text) =>
    text.replace(
      '"corepack pnpm@11.7.0 run build", "corepack pnpm@11.7.0 run generate:site"',
      '"corepack pnpm@11.7.0 run build"',
    ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(incompleteBuild),
    /tracked consumer lifecycle is missing/u,
  );
});
test("the gate requires install to expose the pinned Corepack pnpm shim", () => {
  const hiddenPnpm = mutate(".buildchain/buildchain.toml", (text) =>
    text.replace(
      '"corepack enable pnpm", "corepack pnpm@11.7.0 install --frozen-lockfile"',
      '"corepack pnpm@11.7.0 install --frozen-lockfile"',
    ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(hiddenPnpm),
    /tracked consumer lifecycle is missing/u,
  );
});

test("the gate requires deterministic text checkout on every platform", () => {
  const platformDrift = mutate(".gitattributes", (text) =>
    text.replace("* text=auto eol=lf", "* text=auto"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(platformDrift),
    /cross-platform LF (?:checkout )?contract/u,
  );
});

test("the gate rejects private composite qualification and consumer-Node execution of the Buildchain runtime", () => {
  const targetRoot = fixture();
  const directory = path.join(targetRoot, "actions/build/private");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "action.yml"),
    "runs:\n  using: composite\n  steps:\n    - uses: ./.buildchain/runtime/actions/build/stage-capsule/qualify\n",
  );
  assert.throws(
    () => checkPublicDogfoodContract(targetRoot),
    /outside the public Canary nodes/,
  );
  const unbound = mutate(
    "packages/core/build/stage-capsule/canary.js",
    (text) =>
      text.replaceAll(
        "BUILDCHAIN_NODE: process.execPath",
        "BUILDCHAIN_NODE: process.env.CONSUMER_NODE",
      ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(unbound),
    /Canary lifecycle lost bound execution/,
  );
});
