#!/usr/bin/env node

import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CALLER_PATH = ".github/workflows/self-build-public-consumer-dogfood.yml";
const REUSABLE_PATH = ".github/workflows/public-build-stage-capsule-canary.yml";
export const PUBLIC_DOGFOOD_ALPHA_REF = "v4-alpha";
const PRIVATE_CONSUMER = ["buildchain", "self", "dogfood"].join("-");
const PRIVATE_SHADOW = ["kungfu", "shadow"].join("-");

export function expectedPublicDogfoodWorkflow(validationRef) {
  return `name: V4 Public Consumer Dogfood

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  dogfood:
    uses: kungfu-systems/buildchain/.github/workflows/public-build-stage-capsule-canary.yml@${validationRef}
    with:
      consumer: buildchain
      node-version: "24"
      go-version: "1.25.x"
      install-artifact-path: node_modules/.modules.yaml
      build-artifact-path: actions/build/run-lifecycle/dist/index.js
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

const CANARY_PHASES = ["consumer-admission", "qualify", "reconcile"];

function assertReusableWorkflow(root) {
  const reusable = read(root, REUSABLE_PATH);
  const workflow = YAML.parse(reusable);
  if (!Object.hasOwn(workflow.on || {}, "workflow_call"))
    fail("Canary must expose workflow_call");
  const nodes = CANARY_PHASES.map((phase) => {
    const nodePath = `actions/build/stage-capsule-canary-${phase}`;
    const call = workflow.jobs?.[phase]?.steps?.at(-1);
    if (
      call?.uses !== `./.buildchain/workflow-shell/${nodePath}` ||
      call.with?.["job-workflow-sha"] !== "${{ toJSON(job.workflow_sha) }}" ||
      call.with?.["request-json"] !== "${{ toJSON(inputs) }}"
    )
      fail(
        `${REUSABLE_PATH} must bind ${phase} to its exact public node and workflow SHA`,
      );
    return read(root, `${nodePath}/action.yml`);
  });
  const qualification = YAML.parse(nodes[1]);
  const steps = qualification.runs.steps;
  const prepare = steps.findIndex((step) => step.id === "buildchain-runtime");
  const consumerNode = steps.findIndex((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  if (
    prepare < 0 ||
    prepare >= consumerNode ||
    steps[prepare].uses !==
      "./.buildchain/workflow-shell/actions/runtime/prepare"
  )
    fail(
      "Canary must bind the Buildchain runtime before selecting the consumer Node version",
    );
  if (
    steps[consumerNode].with?.["node-version"] !==
    "${{ fromJSON(inputs.request-json).node-version }}"
  )
    fail("Canary must preserve the requested consumer Node version");
  for (const stage of ["install", "build", "verify"]) {
    const step = steps.find((step) =>
      step.run?.includes(`lifecycle run ${stage}`),
    );
    if (
      !step ||
      !step.run.startsWith('"$BUILDCHAIN_NODE" ') ||
      step.env?.BUILDCHAIN_NODE !==
        "${{ steps.buildchain-runtime.outputs.node-path }}" ||
      step.env?.BUILDCHAIN_SOURCE_SHA !== "${{ github.sha }}"
    )
      fail(
        `${REUSABLE_PATH} must execute lifecycle.${stage} with the bound runtime and consumer source`,
      );
  }
  const campaign = steps.find((step) =>
    step.run?.includes("stage-capsule-qualification.mjs campaign"),
  );
  if (
    campaign?.env?.CONSUMER_SOURCE_SHA !== "${{ github.sha }}" ||
    campaign?.env?.BUILDCHAIN_RUNTIME_SHA !== "${{ steps.runtime.outputs.sha }}"
  )
    fail("Canary campaign lost its exact source/runtime bindings");
  const go = steps.find((step) => step.uses?.startsWith("actions/setup-go@"));
  if (go?.if !== "fromJSON(inputs.request-json).go-version != ''")
    fail("Canary must retain its optional declared Go toolchain");
  for (const source of [reusable, ...nodes]) {
    for (const forbidden of [
      "lifecycle run publish",
      "self-hosted",
      "secrets: inherit",
    ])
      if (source.toLowerCase().includes(forbidden))
        fail(`${REUSABLE_PATH} contains forbidden authority ${forbidden}`);
    if (/\baws\b/iu.test(source))
      fail(`${REUSABLE_PATH} contains forbidden AWS authority`);
  }
}

function assertActionInventory(root) {
  const allowed = new Set(
    CANARY_PHASES.map(
      (phase) => `actions/build/stage-capsule-canary-${phase}/action.yml`,
    ),
  );
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (/^action\.ya?ml$/u.test(entry.name) && !allowed.has(child)) {
        const source = read(root, child);
        if (
          source.includes("actions/build/stage-capsule-canary-") ||
          source.includes(
            "packages/core/build/commands/stage-capsule-qualification.mjs",
          )
        )
          fail(
            `${child} invokes private qualification outside the public Canary nodes`,
          );
      }
    }
  }
  visit("actions");
}

function assertWorkflowInventory(root) {
  const workflowRoot = path.join(root, ".github/workflows");
  for (const entry of fs.readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    let relative = `.github/workflows/${entry.name}`;
    const text = read(root, relative);
    if (
      relative !== REUSABLE_PATH &&
      (text.includes(
        "packages/core/build/commands/stage-capsule-qualification.mjs",
      ) ||
        text.includes("actions/build/stage-capsule-canary-"))
    )
      fail(`${relative} invokes the private qualification script directly`);
    if (
      relative !== CALLER_PATH &&
      text.includes(".github/workflows/public-build-stage-capsule-canary.yml@")
    )
      fail(`${relative} creates a second v4 dogfood caller`);
    if (relative !== REUSABLE_PATH && relative !== CALLER_PATH)
      assertNoPrivateMarkers(relative, text);
  }
}

function assertProtectedVerify(root) {
  const verify = read(root, ".github/workflows/self-build-verify.yml");
  const parsed = YAML.parse(verify);
  const nodePath = "actions/build/verify-check/action.yml";
  if (
    parsed.jobs.check.needs !== "stage-capsule-checkpoints" ||
    parsed.jobs.check.steps.at(-1).uses !==
      `./.buildchain/workflow-shell/${nodePath.replace(/\/action.yml$/, "")}`
  )
    fail(
      "Verify must bind the protected check node after Stage Capsule checkpoints",
    );
  const implementation = read(root, nodePath);
  for (const required of [
    "name: Run declared verify lifecycle (full source tests and generated artifact checks)",
    "node .buildchain/runtime/bin/buildchain.mjs lifecycle run verify",
    "run: node packages/core/build/commands/source-verification-evidence.mjs plan",
    "run: node packages/core/build/commands/source-verification-evidence.mjs seal",
  ])
    if (!implementation.includes(required))
      fail(`Verify is missing protected gate ${required}`);
  for (const forbidden of [
    "stage-capsule-qualification:",
    "stage-capsule-qualification-reconciliation:",
    "packages/core/build/commands/stage-capsule-qualification.mjs",
  ])
    if ((verify + implementation).includes(forbidden))
      fail(`Verify retains private dogfood path ${forbidden}`);
}

function assertArchitecture(root) {
  const architecture = exactJson(
    root,
    "architecture/stage-capsule-qualification.json",
  );
  const dogfood = architecture.publicConsumerDogfood;
  const validationRef = dogfood?.validationRef;
  if (validationRef !== PUBLIC_DOGFOOD_ALPHA_REF)
    fail("architecture validationRef must use the floating v4-alpha channel");
  const caller = read(root, CALLER_PATH);
  if (caller !== expectedPublicDogfoodWorkflow(validationRef))
    fail(`${CALLER_PATH} must remain the exact thin public consumer caller`);
  if (JSON.stringify(architecture.campaign?.consumers) !== '["buildchain"]')
    fail(
      "architecture must qualify only the public Buildchain consumer identity",
    );
  if (
    !dogfood ||
    dogfood.callerWorkflow !== CALLER_PATH ||
    dogfood.reusableWorkflow !==
      "kungfu-systems/buildchain/.github/workflows/public-build-stage-capsule-canary.yml" ||
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
    dogfood.recursionRecovery !== "floating-selector-with-trusted-runtime-input"
  )
    fail(
      "architecture publicConsumerDogfood contract is incomplete or widened",
    );
  for (const key of ["selfDogfood", "kungfuShadow", "externalConsumerCanary"])
    if (Object.hasOwn(architecture, key))
      fail(`architecture retains duplicate ${key}`);
  if (
    architecture.mode !== "shadow-only" ||
    architecture.productionAuthority !== "v4-native" ||
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
    '[lifecycle.build]\ncommand = "corepack pnpm@11.7.0 run build && corepack pnpm@11.7.0 run generate:site"',
    "[lifecycle.verify]\ncommands = [",
    '"corepack pnpm@11.7.0 run check",',
  ])
    if (!lifecycle.includes(declaration))
      fail(
        `tracked consumer lifecycle is missing ${declaration.split("\n")[0]}`,
      );
  const attributes = read(root, ".gitattributes");
  if (!attributes.split("\n").includes("* text=auto eol=lf"))
    fail("consumer checkout is missing the cross-platform LF contract");
}

function assertPolicySources(root) {
  for (const relative of [
    "packages/core/build/stage-capsule-qualification.js",
    "packages/core/build/stage-capsule-qualification-campaign.js",
    "packages/core/build/commands/stage-capsule-qualification.mjs",
    "architecture/stage-capsule-qualification.json",
    "docs/v4-stage-capsule.md",
  ])
    assertNoPrivateMarkers(relative, read(root, relative));

  const agents = read(root, "AGENTS.md");
  for (const invariant of [
    "same public reusable-workflow contract as every other consumer",
    "No agent may add or restore a relative/self reusable-workflow call",
    "never solve recursion with an internal exception",
    "scripts/check-public-dogfood-contract.mjs",
    "source-persisted exact commit SHA",
    "v4-alpha",
  ])
    if (!agents.includes(invariant))
      fail(`AGENTS.md is missing invariant: ${invariant}`);

  const packageJson = exactJson(root, "package.json");
  if (
    !String(packageJson.scripts?.check || "").includes(
      "node scripts/check-public-dogfood-contract.mjs",
    )
  )
    fail("pnpm run check does not include the public dogfood gate");
}

export function checkPublicDogfoodContract(root = DEFAULT_ROOT) {
  assertReusableWorkflow(root);
  assertWorkflowInventory(root);
  assertActionInventory(root);
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
    productionAuthority: "v4-native",
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(`${JSON.stringify(checkPublicDogfoodContract())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
