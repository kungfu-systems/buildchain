#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  runNextDevelopmentController,
  validateNextDevelopmentController,
} from "../packages/core/next-development-controller.js";
import {
  NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
  nextDevelopmentRoot,
} from "../packages/core/next-development-transition.js";
import {
  DurableStore,
  HOSTED_READBACK_PATHS,
  PROTECTED_DEV_BRANCH,
  RECORDED_AT,
  VersionStateAdapterHarness,
  adapterTransition,
  anchorInput,
  exactRoot,
  exactSha,
  fixtureSha,
  repository,
  required,
  validateAdapterEvidence,
  validateAdapterOperation,
  validateRecoveryEvidence,
  validateSelfDogfoodRoute,
} from "./next-development-self-dogfood-harness.mjs";

export const NEXT_DEVELOPMENT_SELF_DOGFOOD_CHECKPOINT =
  "kungfu-buildchain-next-development-self-dogfood-checkpoint/v1";
export const NEXT_DEVELOPMENT_SELF_DOGFOOD_EVIDENCE =
  "kungfu-buildchain-next-development-self-dogfood/v1";
export const HOSTED_SELF_DOGFOOD_EVIDENCE =
  "kungfu-buildchain-alpha-self-dogfood";

function checkpointBody(checkpoint) {
  const body = structuredClone(checkpoint);
  delete body.checkpointRoot;
  return body;
}

function evidenceBody(evidence) {
  const body = structuredClone(evidence);
  delete body.evidenceRoot;
  return body;
}

export function validateSelfDogfoodCheckpoint(checkpoint) {
  if (checkpoint?.contract !== NEXT_DEVELOPMENT_SELF_DOGFOOD_CHECKPOINT) {
    throw new Error("next-development self-dogfood checkpoint contract mismatch");
  }
  const runtimeSha = exactSha(checkpoint.route?.runtimeSha, "route.runtimeSha");
  exactRoot(checkpoint.route?.contractRoot, "route.contractRoot");
  const targetRepository = repository(checkpoint.route?.repository, "route.repository");
  if (
    checkpoint.route.runtimeRef !== "v3-alpha" ||
    checkpoint.route.publicWorkflow !==
      `${targetRepository}/.github/workflows/build.yml@v3-alpha` ||
    targetRepository !== "kungfu-systems/buildchain"
  ) {
    throw new Error("checkpoint requires the public owner/repo v3-alpha route");
  }
  if (runtimeSha !== checkpoint.route.runtimeSha) {
    throw new Error("checkpoint runtime SHA is not canonical");
  }
  required(checkpoint.faultRunnerId, "faultRunnerId");
  const semver = validateNextDevelopmentController(checkpoint.semver.controller);
  const anchored = validateNextDevelopmentController(checkpoint.anchored.controller);
  if (
    semver.transition.state.status !== "planned" ||
    semver.activeAttempt !== null ||
    checkpoint.semver.materializations !== 1 ||
    checkpoint.semver.adapterOperations?.length !== 1 ||
    checkpoint.semver.durableStateFailures !== 1
  ) {
    throw new Error("semver checkpoint must prove one transient durable-state failure");
  }
  checkpoint.semver.adapterOperations.forEach(validateAdapterOperation);
  if (
    anchored.transition.state.status !== "waiting-anchor" ||
    anchored.transition.target.version !== null ||
    checkpoint.anchored.materializations !== 0
  ) {
    throw new Error("anchored checkpoint must persist manual waiting");
  }
  if (checkpoint.alphaCandidateRebuilds !== 0) {
    throw new Error("post-Alpha proof must not rebuild the Alpha candidate");
  }
  if (checkpoint.checkpointRoot !== nextDevelopmentRoot(checkpointBody(checkpoint))) {
    throw new Error("next-development self-dogfood checkpoint root drifted");
  }
  return structuredClone(checkpoint);
}

export async function createSelfDogfoodCheckpoint({
  repository: targetRepository,
  runtimeRef,
  runtimeSha,
  contractRoot,
  runnerId,
} = {}) {
  const routeRepository = repository(targetRepository);
  const route = {
    repository: routeRepository,
    publicWorkflow: `${routeRepository}/.github/workflows/build.yml@v3-alpha`,
    runtimeRef: required(runtimeRef, "runtimeRef"),
    runtimeSha: exactSha(runtimeSha, "runtimeSha"),
    contractRoot: exactRoot(contractRoot, "contractRoot"),
    protectedDevBranch: PROTECTED_DEV_BRANCH,
    hostedReadbackPaths: HOSTED_READBACK_PATHS,
  };
  if (
    route.repository !== "kungfu-systems/buildchain" ||
    route.runtimeRef !== "v3-alpha"
  ) {
    throw new Error("self-dogfood checkpoint requires the public kungfu-systems/buildchain v3-alpha route");
  }

  const semverStore = new DurableStore([], { transientFailures: 1 });
  const semverExecutor = new VersionStateAdapterHarness({ route });
  await runNextDevelopmentController(
    {
      transition: adapterTransition(route, "semver"),
      protectedDevBranch: PROTECTED_DEV_BRANCH,
      recordedAt: RECORDED_AT,
    },
    { store: semverStore, executor: semverExecutor },
  ).then(
    () => {
      throw new Error("transient durable-state fault injection did not run");
    },
    (error) => {
      if (!/injected transient durable-state write failure/u.test(error.message)) {
        throw error;
      }
    },
  );

  const anchoredStore = new DurableStore();
  const anchoredExecutor = new VersionStateAdapterHarness({ route });
  await runNextDevelopmentController(
    {
      transition: adapterTransition(route, "anchored"),
      protectedDevBranch: PROTECTED_DEV_BRANCH,
      recordedAt: RECORDED_AT,
    },
    { store: anchoredStore, executor: anchoredExecutor },
  );

  const checkpoint = {
    schemaVersion: 1,
    contract: NEXT_DEVELOPMENT_SELF_DOGFOOD_CHECKPOINT,
    route,
    faultRunnerId: required(runnerId, "runnerId"),
    alphaCandidateRebuilds: 0,
    semver: {
      controller: semverStore.only(),
      materializations: semverExecutor.materializations,
      adapterOperations: semverExecutor.operationRecords(),
      durableStateFailures: semverStore.transientFailures,
    },
    anchored: {
      controller: anchoredStore.only(),
      materializations: anchoredExecutor.materializations,
    },
  };
  checkpoint.checkpointRoot = nextDevelopmentRoot(checkpoint);
  return validateSelfDogfoodCheckpoint(checkpoint);
}

function assertVerifiedModel(model, label) {
  const controller = validateNextDevelopmentController(model?.controller);
  if (
    model.status !== "verified" ||
    controller.transition.state.status !== "verified" ||
    model.controllerRoot !== controller.controllerRoot ||
    model.readbackRoot !== nextDevelopmentRoot(controller.readback)
  ) {
    throw new Error(`${label} does not bind its verified controller and readback`);
  }
  return controller;
}

export function validateSelfDogfoodEvidence(evidence) {
  if (evidence?.contract !== NEXT_DEVELOPMENT_SELF_DOGFOOD_EVIDENCE) {
    throw new Error("next-development self-dogfood evidence contract mismatch");
  }
  exactRoot(evidence.checkpointRoot, "checkpointRoot");
  exactRoot(evidence.transactionRoot, "transactionRoot");
  exactRoot(evidence.protectedDevReadbackRoot, "protectedDevReadbackRoot");
  validateSelfDogfoodRoute(evidence.route);
  const semver = assertVerifiedModel(evidence.models?.semverAuto, "semver/auto");
  const anchored = assertVerifiedModel(evidence.models?.anchoredManual, "anchored/manual");
  if (evidence.status !== "passed") throw new Error("self-dogfood evidence did not pass");
  validateRecoveryEvidence(evidence.recovery);
  if (
    semver.controllerRoot !== evidence.transactionRoot ||
    nextDevelopmentRoot(semver.readback) !== evidence.protectedDevReadbackRoot ||
    evidence.models.anchoredManual.waitingStatus !== "waiting-anchor" ||
    evidence.models.anchoredManual.waitingControllerRoot === anchored.controllerRoot
  ) {
    throw new Error("both legal next-development models must be proved");
  }
  validateAdapterEvidence(evidence.adapter, semver, anchored);
  if (
    evidence.adoption?.coordinate !==
      "kungfu-systems/buildchain/.github/workflows/build.yml@v3" ||
    evidence.adoption?.exactShaProductionPin !== false
  ) {
    throw new Error("Kungfu adoption must use the floating v3 coordinate");
  }
  if (evidence.evidenceRoot !== nextDevelopmentRoot(evidenceBody(evidence))) {
    throw new Error("next-development self-dogfood evidence root drifted");
  }
  return structuredClone(evidence);
}

export async function resumeSelfDogfoodCheckpoint(checkpointInput, { runnerId } = {}) {
  const checkpoint = validateSelfDogfoodCheckpoint(checkpointInput);
  const resumeRunnerId = required(runnerId, "runnerId");
  if (resumeRunnerId === checkpoint.faultRunnerId) {
    throw new Error("post-Alpha recovery must run on a fresh runner identity");
  }

  const initialDevSha = fixtureSha("protected-dev:initial");
  const movedDevSha = fixtureSha("protected-dev:moved-during-recovery");
  const semverStore = new DurableStore([checkpoint.semver.controller]);
  const semverExecutor = new VersionStateAdapterHarness({
    route: checkpoint.route,
    operations: checkpoint.semver.adapterOperations,
    devSha: initialDevSha,
    movedDevSha,
    moveAfterRecoveredOperation: true,
    pullRequestReadsBeforeMerge: 2,
  });
  const input = {
    transition: adapterTransition(checkpoint.route, "semver"),
    protectedDevBranch: PROTECTED_DEV_BRANCH,
    recordedAt: RECORDED_AT,
  };
  const superseded = await runNextDevelopmentController(input, {
    store: semverStore,
    executor: semverExecutor,
  });
  const pending = await runNextDevelopmentController(input, {
    store: semverStore,
    executor: semverExecutor,
  });
  const delayed = await runNextDevelopmentController(input, {
    store: semverStore,
    executor: semverExecutor,
  });
  const semver = await runNextDevelopmentController(input, {
    store: semverStore,
    executor: semverExecutor,
  });

  const anchoredStore = new DurableStore([checkpoint.anchored.controller]);
  const anchoredExecutor = new VersionStateAdapterHarness({ route: checkpoint.route });
  const anchored = await runNextDevelopmentController(
    {
      transition: adapterTransition(checkpoint.route, "anchored"),
      protectedDevBranch: PROTECTED_DEV_BRANCH,
      reviewedInput: anchorInput(),
      recordedAt: RECORDED_AT,
    },
    { store: anchoredStore, executor: anchoredExecutor },
  );

  const semverReadbackRoot = nextDevelopmentRoot(semver.readback);
  const anchoredReadbackRoot = nextDevelopmentRoot(anchored.readback);
  const evidence = {
    schemaVersion: 1,
    contract: NEXT_DEVELOPMENT_SELF_DOGFOOD_EVIDENCE,
    status: "passed",
    route: checkpoint.route,
    checkpointRoot: checkpoint.checkpointRoot,
    transactionRoot: semver.controllerRoot,
    protectedDevReadbackRoot: semverReadbackRoot,
    recovery: {
      faultRunnerId: checkpoint.faultRunnerId,
      resumeRunnerId,
      freshRunner: true,
      transientDurableStateFailures: checkpoint.semver.durableStateFailures,
      recoveredAdapterOperations: semverExecutor.recoveredOperations,
      alphaCandidateRebuilds: 0,
      devMaterializationsBefore: checkpoint.semver.materializations,
      devMaterializationsAfter: semverExecutor.materializations,
      protectedDevMovement: {
        initialSha: initialDevSha,
        movedSha: movedDevSha,
        supersededAttempts: superseded.attempts.filter(
          (attempt) => attempt.status === "superseded",
        ).length,
      },
      protectedPrDelay: {
        status: pending.transition.state.status,
        delayedStatus: delayed.transition.state.status,
        unchangedControllerRoot: pending.controllerRoot === delayed.controllerRoot,
      },
    },
    adapter: {
      boundary: "materializeNextDevelopmentTransition",
      contract: NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
      operations: [
        ...semverExecutor.operationRecords(),
        ...anchoredExecutor.operationRecords(),
      ],
    },
    models: {
      semverAuto: {
        status: semver.transition.state.status,
        targetVersion: semver.transition.target.version,
        controllerRoot: semver.controllerRoot,
        readbackRoot: semverReadbackRoot,
        controller: semver,
      },
      anchoredManual: {
        waitingStatus: checkpoint.anchored.controller.transition.state.status,
        waitingControllerRoot: checkpoint.anchored.controller.controllerRoot,
        status: anchored.transition.state.status,
        targetVersion: anchored.transition.target.version,
        controllerRoot: anchored.controllerRoot,
        readbackRoot: anchoredReadbackRoot,
        controller: anchored,
      },
    },
    adoption: {
      coordinate: "kungfu-systems/buildchain/.github/workflows/build.yml@v3",
      runtimeRef: "v3",
      exactShaProductionPin: false,
    },
  };
  evidence.evidenceRoot = nextDevelopmentRoot(evidence);
  return validateSelfDogfoodEvidence(evidence);
}

function normalizeHostedReadback(value, route) {
  const paths = (value?.versionRoots || [])
    .map((entry, index) => ({
      path: required(entry?.path, `hosted versionRoots[${index}].path`),
      gitBlobSha: exactSha(
        entry?.gitBlobSha,
        `hosted versionRoots[${index}].gitBlobSha`,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(paths.map((entry) => entry.path)) !== JSON.stringify(route.hostedReadbackPaths)) {
    throw new Error("hosted protected Dev readback must exactly cover declared paths");
  }
  const body = {
    repository: repository(value?.repository, "hosted readback repository"),
    branch: required(value?.branch, "hosted readback branch"),
    commitSha: exactSha(value?.commitSha, "hosted readback commitSha"),
    treeSha: exactSha(value?.treeSha, "hosted readback treeSha"),
    versionRoots: paths,
  };
  if (body.repository !== route.repository || body.branch !== route.protectedDevBranch) {
    throw new Error("hosted protected Dev readback route drifted");
  }
  return { ...body, evidenceRoot: nextDevelopmentRoot(body) };
}

export function createHostedSelfDogfoodEvidence({ nextDevelopment, observation } = {}) {
  const proof = validateSelfDogfoodEvidence(nextDevelopment);
  const hostedProtectedDevReadback = normalizeHostedReadback(
    observation?.protectedDevReadback,
    proof.route,
  );
  const observed = structuredClone(observation?.observed || {});
  const failures = [];
  if (observed.alpha?.ref !== "v3-alpha") failures.push("alpha runtime ref mismatch");
  if (observed.alpha?.class !== "alpha") failures.push("alpha runtime class mismatch");
  if (observed.alpha?.sha !== observed.alpha?.expectedSha) failures.push("alpha runtime SHA mismatch");
  if (observed.alpha?.sha !== proof.route.runtimeSha) failures.push("next-development runtime SHA mismatch");
  if (observed.stable?.ref !== "v3") failures.push("stable runtime ref mismatch");
  if (observed.stable?.class !== "stable") failures.push("stable runtime class mismatch");
  if (observed.stable?.sha !== observed.stable?.expectedSha) failures.push("stable runtime SHA mismatch");
  for (const [lane, item] of Object.entries(observed)) {
    exactSha(item?.sha, `observed ${lane} SHA`);
    exactSha(item?.expectedSha, `expected ${lane} SHA`);
  }
  const evidence = {
    schemaVersion: 1,
    contract: HOSTED_SELF_DOGFOOD_EVIDENCE,
    repository: repository(observation?.repository),
    callerSha: exactSha(observation?.callerSha, "callerSha"),
    checkedAt: required(observation?.checkedAt, "checkedAt"),
    status: failures.length === 0 ? "passed" : "failed",
    observed,
    nextDevelopment: proof,
    hostedProtectedDevReadback,
    failures,
  };
  if (evidence.repository !== proof.route.repository) {
    throw new Error("hosted evidence repository differs from the public route");
  }
  evidence.evidenceRoot = nextDevelopmentRoot(evidence);
  return evidence;
}

export function validateHostedSelfDogfoodEvidence(evidence) {
  if (evidence?.contract !== HOSTED_SELF_DOGFOOD_EVIDENCE) {
    throw new Error("hosted self-dogfood evidence contract mismatch");
  }
  const proof = validateSelfDogfoodEvidence(evidence.nextDevelopment);
  repository(evidence.repository);
  exactSha(evidence.callerSha, "callerSha");
  required(evidence.checkedAt, "checkedAt");
  for (const [lane, item] of Object.entries(evidence.observed || {})) {
    exactSha(item?.sha, `observed ${lane} SHA`);
    exactSha(item?.expectedSha, `expected ${lane} SHA`);
  }
  const readback = normalizeHostedReadback(
    evidence.hostedProtectedDevReadback,
    proof.route,
  );
  if (
    readback.evidenceRoot !== evidence.hostedProtectedDevReadback?.evidenceRoot ||
    evidence.evidenceRoot !== nextDevelopmentRoot(evidenceBody(evidence))
  ) {
    throw new Error("hosted self-dogfood evidence root drifted");
  }
  if (
    evidence.status !== "passed" ||
    evidence.failures?.length !== 0 ||
    evidence.repository !== proof.route.repository ||
    evidence.observed?.alpha?.ref !== "v3-alpha" ||
    evidence.observed?.alpha?.class !== "alpha" ||
    evidence.observed?.alpha?.sha !== evidence.observed?.alpha?.expectedSha ||
    evidence.observed?.alpha?.sha !== proof.route.runtimeSha ||
    evidence.observed?.stable?.ref !== "v3" ||
    evidence.observed?.stable?.class !== "stable" ||
    evidence.observed?.stable?.sha !== evidence.observed?.stable?.expectedSha
  ) {
    throw new Error("hosted self-dogfood evidence is not a passing exact readback");
  }
  return structuredClone(evidence);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${name}`);
    }
    options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = argv[index + 1];
    index += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  const output = path.resolve(filePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function writeActionsOutputs(value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    [
      `transaction-root=${value.transactionRoot || value.nextDevelopment?.transactionRoot || ""}`,
      `protected-dev-readback-root=${value.protectedDevReadbackRoot || value.hostedProtectedDevReadback?.evidenceRoot || ""}`,
      `evidence-root=${value.evidenceRoot || value.checkpointRoot || ""}`,
    ].join("\n") + "\n",
  );
}

async function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const options = parseArgs(argv);
  if (command === "checkpoint") {
    const checkpoint = await createSelfDogfoodCheckpoint({
      repository: options.repository,
      runtimeRef: options.runtimeRef,
      runtimeSha: options.runtimeSha,
      contractRoot: options.contractRoot,
      runnerId: options.runnerId,
    });
    writeJson(required(options.output, "output"), checkpoint);
    writeActionsOutputs(checkpoint);
    return checkpoint;
  }
  if (command === "resume") {
    const evidence = await resumeSelfDogfoodCheckpoint(
      readJson(required(options.input, "input")),
      { runnerId: options.runnerId },
    );
    writeJson(required(options.output, "output"), evidence);
    writeActionsOutputs(evidence);
    return evidence;
  }
  if (command === "attest-hosted") {
    const evidence = createHostedSelfDogfoodEvidence({
      nextDevelopment: readJson(required(options.input, "input")),
      observation: readJson(required(options.observation, "observation")),
    });
    writeJson(required(options.output, "output"), evidence);
    writeActionsOutputs(evidence);
    return evidence;
  }
  if (command === "verify") {
    return validateSelfDogfoodEvidence(readJson(required(options.input, "input")));
  }
  if (command === "verify-hosted") {
    return validateHostedSelfDogfoodEvidence(readJson(required(options.input, "input")));
  }
  throw new Error(
    "usage: next-development-self-dogfood.mjs checkpoint|resume|attest-hosted|verify|verify-hosted ...",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`next-development self-dogfood: ${error.message}\n`);
    process.exitCode = 1;
  });
}
