#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CALLER_PATH = ".github/workflows/v4-public-consumer-dogfood.yml";
const REUSABLE_PATH = ".github/workflows/v4-stage-capsule-canary.yml";
export const V4_PUBLIC_DOGFOOD_TRAIN_REF =
  "train/v4/v4.0/public-consumer-self-dogfood";
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const PRIVATE_CONSUMER = ["buildchain", "self", "dogfood"].join("-");
const PRIVATE_SHADOW = ["kungfu", "shadow"].join("-");

export function expectedV4PublicDogfoodWorkflow(validationRef) {
  return `name: V4 Public Consumer Dogfood

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  dogfood:
    uses: kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml@${validationRef}
    with:
      consumer: buildchain
      node-version: "24"
      install-artifact-path: node_modules/.modules.yaml
      build-artifact-path: actions/run-lifecycle/dist/index.js
      verify-artifact-path: dist/site
`;
}

function fail(message) {
  throw new Error(`v4-public-dogfood-contract: ${message}`);
}

function read(root, relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) fail(`${relative} is missing`);
  return fs.readFileSync(file, "utf8");
}

function exactJson(root, relative) {
  try {
    return JSON.parse(read(root, relative));
  } catch (error) {
    fail(`${relative} is not valid JSON: ${error.message}`);
  }
}

function assertNoPrivateMarkers(relative, text) {
  for (const marker of [
    PRIVATE_CONSUMER,
    PRIVATE_SHADOW,
    "selfDogfood",
    "kungfuShadow",
  ])
    if (text.includes(marker))
      fail(`${relative} retains private marker ${marker}`);
}

function assertReusableWorkflow(root) {
  const reusable = read(root, REUSABLE_PATH);
  for (const binding of [
    "workflow_call:",
    "BUILDCHAIN_WORKFLOW_SHA: ${{ job.workflow_sha }}",
    "CONSUMER_SOURCE_SHA: ${{ github.sha }}",
  ])
    if (!reusable.includes(binding))
      fail(`${REUSABLE_PATH} is missing exact binding ${binding}`);
  for (const stage of ["install", "build", "verify"])
    if (!reusable.includes(`lifecycle run ${stage}`))
      fail(`${REUSABLE_PATH} does not execute lifecycle.${stage}`);
  for (const forbidden of [
    "lifecycle run publish",
    "self-hosted",
    "secrets: inherit",
  ])
    if (reusable.toLowerCase().includes(forbidden))
      fail(`${REUSABLE_PATH} contains forbidden authority ${forbidden}`);
  if (/\baws\b/iu.test(reusable))
    fail(`${REUSABLE_PATH} contains forbidden AWS authority`);
}

function assertWorkflowInventory(root) {
  const workflowRoot = path.join(root, ".github/workflows");
  for (const entry of fs.readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    const relative = `.github/workflows/${entry.name}`;
    const text = read(root, relative);
    if (
      relative !== REUSABLE_PATH &&
      text.includes("scripts/v4-stage-capsule-qualification.mjs")
    )
      fail(`${relative} invokes the private qualification script directly`);
    if (
      relative !== CALLER_PATH &&
      text.includes(".github/workflows/v4-stage-capsule-canary.yml@")
    )
      fail(`${relative} creates a second v4 dogfood caller`);
    if (relative !== REUSABLE_PATH && relative !== CALLER_PATH)
      assertNoPrivateMarkers(relative, text);
  }
}

function assertProtectedVerify(root) {
  const verify = read(root, ".github/workflows/verify.yml");
  for (const required of [
    "needs: stage-capsule-checkpoints",
    "name: Enforce public consumer-only v4 dogfood",
    "run: node scripts/check-v4-public-dogfood-contract.mjs",
  ])
    if (!verify.includes(required))
      fail(`Verify is missing protected gate ${required}`);
  for (const forbidden of [
    "stage-capsule-qualification:",
    "stage-capsule-qualification-reconciliation:",
    "scripts/v4-stage-capsule-qualification.mjs",
  ])
    if (verify.includes(forbidden))
      fail(`Verify retains private dogfood path ${forbidden}`);
}

function assertArchitecture(root) {
  const architecture = exactJson(
    root,
    "architecture/v4-stage-capsule-qualification.json",
  );
  const dogfood = architecture.publicConsumerDogfood;
  const validationRef = dogfood?.validationRef;
  if (
    validationRef !== V4_PUBLIC_DOGFOOD_TRAIN_REF &&
    !EXACT_SHA.test(String(validationRef))
  )
    fail(
      "architecture validationRef must be the exact public train or a protected commit SHA",
    );
  const caller = read(root, CALLER_PATH);
  if (caller !== expectedV4PublicDogfoodWorkflow(validationRef))
    fail(`${CALLER_PATH} must remain the exact thin public consumer caller`);
  if (JSON.stringify(architecture.campaign?.consumers) !== '["buildchain"]')
    fail(
      "architecture must qualify only the public Buildchain consumer identity",
    );
  if (
    !dogfood ||
    dogfood.callerWorkflow !== CALLER_PATH ||
    dogfood.reusableWorkflow !==
      "kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml" ||
    dogfood.runtimeBinding !== "job.workflow_sha" ||
    dogfood.consumerSourceBinding !== "github.sha" ||
    JSON.stringify(dogfood.executableStages) !==
      '["install","build","verify"]' ||
    JSON.stringify(dogfood.excludedStages) !==
      '{"version-state":"source-mutation","publish":"provider-mutation"}' ||
    dogfood.consumerOrchestrationCopied !== false ||
    dogfood.relativeOrSelfInvocationAllowed !== false ||
    dogfood.directQualificationInvocationAllowed !== false ||
    dogfood.candidateBranchOverrideAllowed !== false ||
    dogfood.recursionRecovery !== "public-train-ref-only"
  )
    fail(
      "architecture publicConsumerDogfood contract is incomplete or widened",
    );
  for (const key of ["selfDogfood", "kungfuShadow", "externalConsumerCanary"])
    if (Object.hasOwn(architecture, key))
      fail(`architecture retains duplicate ${key}`);
  if (
    architecture.mode !== "shadow-only" ||
    architecture.productionAuthority !== "v3" ||
    [
      "providerEffects",
      "productionWrites",
      "productionReuse",
      "releaseEffects",
      "credentials",
      "aws",
      "selfHostedRunners",
      "v3BehaviorChange",
    ].some((key) => architecture.authority?.[key] !== false)
  )
    fail("architecture authority ceiling changed");
  return validationRef;
}

function assertConsumerLifecycle(root) {
  const lifecycle = read(root, ".buildchain/buildchain.toml");
  for (const declaration of [
    '[lifecycle.install]\ncommand = "corepack enable pnpm && corepack pnpm@11.7.0 install --frozen-lockfile"',
    '[lifecycle.build]\ncommand = "corepack pnpm@11.7.0 -r --filter \\\"./actions/**\\\" build"',
    "[lifecycle.verify]\ncommands = [",
  ])
    if (!lifecycle.includes(declaration))
      fail(
        `tracked consumer lifecycle is missing ${declaration.split("\n")[0]}`,
      );
}

function assertPolicySources(root) {
  for (const relative of [
    "packages/core/v4-stage-capsule-qualification.js",
    "packages/core/v4-stage-capsule-qualification-campaign.js",
    "scripts/v4-stage-capsule-qualification.mjs",
    "architecture/v4-stage-capsule-qualification.json",
    "docs/v4-stage-capsule.md",
  ])
    assertNoPrivateMarkers(relative, read(root, relative));

  const agents = read(root, "AGENTS.md");
  for (const invariant of [
    "same public reusable-workflow contract as every other consumer",
    "No agent may add or restore a relative/self reusable-workflow call",
    "never solve recursion with an internal exception",
    "scripts/check-v4-public-dogfood-contract.mjs",
  ])
    if (!agents.includes(invariant))
      fail(`AGENTS.md is missing invariant: ${invariant}`);

  const packageJson = exactJson(root, "package.json");
  if (
    !String(packageJson.scripts?.check || "").includes(
      "node scripts/check-v4-public-dogfood-contract.mjs",
    )
  )
    fail("pnpm run check does not include the public dogfood gate");
}

export function checkV4PublicDogfoodContract(root = DEFAULT_ROOT) {
  assertReusableWorkflow(root);
  assertWorkflowInventory(root);
  assertProtectedVerify(root);
  const validationRef = assertArchitecture(root);
  assertConsumerLifecycle(root);
  assertPolicySources(root);

  return {
    schema: "buildchain-v4-public-dogfood-contract-check/v1",
    ok: true,
    caller: CALLER_PATH,
    reusable: REUSABLE_PATH,
    validationRef,
    productionAuthority: "v3",
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(`${JSON.stringify(checkV4PublicDogfoodContract())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
