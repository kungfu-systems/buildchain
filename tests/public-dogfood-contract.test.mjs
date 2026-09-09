import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLIC_DOGFOOD_ALPHA_REF,
  checkPublicDogfoodContract,
  expectedPublicDogfoodWorkflow,
} from "../scripts/check-public-dogfood-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const protectedDogfoodRef = PUBLIC_DOGFOOD_ALPHA_REF;
const fixturePaths = [
  "actions/build/verify-check",
  "architecture/workflow-taxonomy.json",
  ...["consumer-admission", "qualify", "reconcile"].map(
    (phase) => `actions/build/stage-capsule-canary-${phase}`,
  ),
  ".buildchain/buildchain.toml",
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
  assert.deepEqual(checkPublicDogfoodContract(root), {
    schema: "buildchain-v4-public-dogfood-contract-check/v1",
    ok: true,
    caller: ".github/workflows/self-build-public-consumer-dogfood.yml",
    reusable: ".github/workflows/public-build-stage-capsule-canary.yml",
    validationRef: protectedDogfoodRef,
    productionAuthority: "v4-native",
  });
});

test("the gate rejects copied orchestration and relative reusable calls", () => {
  const copied = mutate(
    ".github/workflows/self-build-public-consumer-dogfood.yml",
    (text) => `${text}\n    steps:\n      - run: echo bypass\n`,
  );
  assert.throws(
    () => checkPublicDogfoodContract(copied),
    /exact thin public consumer caller/u,
  );

  const relative = mutate(
    ".github/workflows/self-build-public-consumer-dogfood.yml",
    (text) =>
      text.replace(
        "kungfu-systems/buildchain/.github/workflows/public-build-stage-capsule-canary.yml@",
        "./.github/workflows/public-build-stage-capsule-canary.yml#",
      ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(relative),
    /exact thin public consumer caller/u,
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

test("the gate permits only the floating v4-alpha source selector", () => {
  const feature = mutate(
    "architecture/stage-capsule-qualification.json",
    (text) => text.replace(protectedDogfoodRef, "feature/private-candidate"),
  );
  assert.throws(
    () => checkPublicDogfoodContract(feature),
    /floating v4-alpha channel/u,
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

  const unprotected = mutate("actions/build/verify-check/action.yml", (text) =>
    text.replace(
      "node .buildchain/runtime/bin/buildchain.mjs lifecycle run verify",
      "run: true",
    ),
  );
  assert.throws(
    () => checkPublicDogfoodContract(unprotected),
    /Verify is missing protected gate/u,
  );
});

test("the gate requires build to use public scripts and refresh verify outputs", () => {
  const incompleteBuild = mutate(".buildchain/buildchain.toml", (text) =>
    text.replace(
      "corepack pnpm@11.7.0 run build && corepack pnpm@11.7.0 run generate:site",
      'corepack pnpm@11.7.0 -r --filter "./actions/**" build',
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
      "corepack enable pnpm && corepack pnpm@11.7.0 install --frozen-lockfile",
      "corepack pnpm@11.7.0 install --frozen-lockfile",
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
    /cross-platform LF contract/u,
  );
});

test("the gate rejects private composite qualification and consumer-Node execution of the Buildchain runtime", () => {
  const targetRoot = fixture();
  const directory = path.join(targetRoot, "actions/build/private");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "action.yml"),
    "runs:\n  using: composite\n  steps:\n    - uses: ./.buildchain/workflow-shell/actions/build/stage-capsule-canary-qualify\n",
  );
  assert.throws(
    () => checkPublicDogfoodContract(targetRoot),
    /outside the public Canary nodes/,
  );
  const unbound = mutate(
    "actions/build/stage-capsule-canary-qualify/action.yml",
    (text) => text.replaceAll('"$BUILDCHAIN_NODE" ', "node "),
  );
  assert.throws(
    () => checkPublicDogfoodContract(unbound),
    /bound runtime and consumer source/,
  );
});
