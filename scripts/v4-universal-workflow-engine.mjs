#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  admitV4UniversalWorkflow,
  completeV4UniversalWorkflow,
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";
import {
  createV4ReleaseInvocation,
  createV4ReleaseReceipt,
  createV4ReleaseTransaction,
  planV4ReleaseRoute,
} from "../packages/core/v4-release-invocation.js";
import { assertV4DeclarativePromotionInputs } from "../packages/core/v4-publication-qualification.js";
import {
  githubJson,
  resolveReleaseCandidateArtifacts,
} from "./release-candidate-resolver.mjs";

function fail(message) {
  throw new Error(message);
}

function readJsonEnvironment(name) {
  const source = process.env[name];
  if (!source) fail(`${name} is required`);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

function exactRuntime(admission) {
  const runtime = admission?.runtime;
  if (
    admission?.status !== "admitted" ||
    runtime?.repository !== "kungfu-systems/buildchain" ||
    !/^[0-9a-f]{40}$/u.test(runtime?.sha || "")
  )
    fail("an exact admitted Buildchain runtime is required");
  return runtime;
}

function contentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(value)}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${label} has an invalid field set`);
}

function validateWorkflowInputs(workflowId, inputs) {
  const registry = JSON.parse(
    fs.readFileSync(
      new URL("../dist/site/workflow-registry.json", import.meta.url),
    ),
  );
  const workflow = registry.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) fail(`candidate workflow registry is missing ${workflowId}`);
  const allowed = new Set(workflow.inputs);
  const unknown = Object.keys(inputs).filter((name) => !allowed.has(name));
  if (unknown.length > 0)
    fail(
      `candidate payload has unregistered workflow inputs: ${unknown.sort().join(", ")}`,
    );
}

function actionEnvironment(inputs, outputPath) {
  const environment = { ...process.env, GITHUB_OUTPUT: outputPath };
  for (const [name, value] of Object.entries(inputs))
    environment[`INPUT_${name.replace(/ /gu, "_").toUpperCase()}`] =
      typeof value === "boolean" ? String(value) : String(value ?? "");
  return environment;
}

function readGitHubOutputs(outputPath) {
  const source = fs.readFileSync(outputPath, "utf8");
  const outputs = {};
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredoc = line.match(/^([^<]+)<<(.+)$/u);
    if (heredoc) {
      const values = [];
      while (index + 1 < lines.length && lines[index + 1] !== heredoc[2])
        values.push(lines[(index += 1)]);
      if (index + 1 >= lines.length)
        fail(`GitHub output ${heredoc[1]} has no closing delimiter`);
      index += 1;
      outputs[heredoc[1]] = values.join("\n");
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0)
      outputs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return outputs;
}

function rawFileRoot(relative) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(new URL(`../${relative}`, import.meta.url)));
  return `sha256:${hash.digest("hex")}`;
}

function executeBootstrapConformance(request, admission) {
  exactObject(
    request.payload,
    ["schema", "expectedGovernedWorkflowCount"],
    "bootstrap conformance payload",
  );
  if (
    request.payload.schema !==
    "kungfu-buildchain-v4-universal-bootstrap-conformance/v1"
  )
    fail("bootstrap conformance payload schema is unsupported");
  if (
    !Number.isSafeInteger(request.payload.expectedGovernedWorkflowCount) ||
    request.payload.expectedGovernedWorkflowCount < 1
  )
    fail("bootstrap conformance workflow count is invalid");
  const architecture = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-universal-workflow-bootstrap.json",
        import.meta.url,
      ),
    ),
  );
  const policy = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-universal-workflow-train-admission.json",
        import.meta.url,
      ),
    ),
  );
  if (
    architecture.bootstrapGovernedWorkflows.length !==
      request.payload.expectedGovernedWorkflowCount ||
    architecture.migration.candidateEngine !== "bounded-capability-adapters" ||
    policy.allowedCapabilities.includes("workflow-contract")
  )
    fail("candidate Bootstrap conformance does not close execution semantics");
  for (const relative of architecture.bootstrapGovernedWorkflows) {
    const source = fs.readFileSync(
      new URL(`../${relative}`, import.meta.url),
      "utf8",
    );
    if (
      relative !== architecture.bootstrap.publicWorkflow &&
      !/(?:\.\/)?\.github\/workflows\/bootstrap\.yml/u.test(source)
    )
      fail(`candidate Bootstrap facade is not governed: ${relative}`);
  }
  return {
    schema: "kungfu-buildchain-v4-universal-bootstrap-conformance-result/v1",
    status: "candidate-engine-executed",
    runtime: exactRuntime(admission),
    governedWorkflowCount: architecture.bootstrapGovernedWorkflows.length,
    architectureRoot: rawFileRoot(
      "architecture/v4-universal-workflow-bootstrap.json",
    ),
    engineRoot: rawFileRoot("scripts/v4-universal-workflow-engine.mjs"),
  };
}

async function observeReleaseRoute({
  repository,
  targetRef,
  requestedSha,
  inputs,
}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const observed = await githubJson({
    apiUrl,
    token,
    path: `/repos/${repository}/git/ref/heads/${targetRef}`,
  });
  const currentSha = observed.object.sha;
  let comparisonStatus = "identical";
  if (currentSha !== requestedSha) {
    const comparison = await githubJson({
      apiUrl,
      token,
      path: `/repos/${repository}/compare/${requestedSha}...${currentSha}`,
    });
    comparisonStatus = comparison.status;
  }
  return planV4ReleaseRoute({
    requestedSha,
    observedSha: currentSha,
    comparisonStatus,
    requestedChannel: inputs.channel,
    targetRef,
    dryRun: inputs["dry-run"] === true,
    resume:
      String(inputs["resume-candidate-run-id"] || "") !== "" ||
      inputs["publish-transaction-override"] === true,
  });
}

function verifiedReleaseDocuments() {
  const base = path.resolve(".buildchain/release-tail");
  const invocation = JSON.parse(
    fs.readFileSync(path.join(base, "release-invocation.json")),
  );
  const transaction = JSON.parse(
    fs.readFileSync(path.join(base, "release-transaction.json")),
  );
  const storedReceipt = JSON.parse(
    fs.readFileSync(path.join(base, "release-receipt.json")),
  );
  const invocationProjection = createV4ReleaseInvocation(invocation);
  const transactionProjection = createV4ReleaseTransaction({
    invocationRoot: transaction.invocationRoot,
    publisherRoot: transaction.publisherRoot,
    runtimeRoot: transaction.runtimeRoot,
    providerRoot: transaction.providerRoot,
    parentRoot: transaction.parentRoot,
  });
  const { receiptRoot, ...receipt } = storedReceipt;
  const receiptProjection = createV4ReleaseReceipt(receipt);
  if (
    transaction.invocationRoot !== invocationProjection.roots.invocationRoot ||
    transaction.transactionRoot !== transactionProjection.transactionRoot ||
    receipt.transactionRoot !== transactionProjection.transactionRoot ||
    receiptProjection.receiptRoot !== receiptRoot ||
    receipt.outcome !== "complete"
  )
    fail("terminal ReleaseReceipt lineage does not verify");
  return { invocation, transaction, receipt: storedReceipt };
}

async function executeReleasePromotion(request, admission) {
  const payload = request.payload;
  exactObject(
    payload,
    ["schema", "inputs", "dryRunObservation"],
    "release promotion payload",
  );
  if (payload.schema !== "kungfu-buildchain-v4-universal-release-promotion/v1")
    fail("release promotion payload schema is unsupported");
  exactObject(
    payload.inputs,
    Object.keys(payload.inputs),
    "release promotion inputs",
  );
  validateWorkflowInputs("release-candidate-promote", payload.inputs);
  assertV4DeclarativePromotionInputs(payload.inputs);
  const repository = request.consumer.repository;
  const targetRef = String(payload.inputs["target-ref"] || "").replace(
    /^refs\/heads\//u,
    "",
  );
  const requestedSha = String(
    payload.inputs["target-sha"] || request.consumer.sourceSha,
  );
  let route;
  if (payload.inputs["dry-run"] === true && payload.dryRunObservation) {
    exactObject(
      payload.dryRunObservation,
      ["observedSha", "comparisonStatus"],
      "dry-run observation",
    );
    route = planV4ReleaseRoute({
      requestedSha,
      observedSha: payload.dryRunObservation.observedSha,
      comparisonStatus: payload.dryRunObservation.comparisonStatus,
      requestedChannel: payload.inputs.channel,
      targetRef,
      dryRun: true,
      resume: false,
    });
  } else {
    route = await observeReleaseRoute({
      repository,
      targetRef,
      requestedSha,
      inputs: payload.inputs,
    });
  }
  if (route.decision === "Blocked")
    fail(`release route blocked: ${route.reason}`);
  if (route.decision === "NoOp" || payload.inputs["dry-run"] === true)
    return { route, dryRun: payload.inputs["dry-run"] === true };
  const candidate = await resolveReleaseCandidateArtifacts({
    repository,
    targetRef: route.targetRef,
    targetSha: route.requestedSha,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    workflowFile: payload.inputs["release-candidate-workflow-file"],
    workflowName: payload.inputs["release-candidate-workflow-name"],
    artifactName: payload.inputs["artifact-name"],
    artifactPatterns: payload.inputs["artifact-patterns"],
    githubReleasePayloadPatterns:
      payload.inputs["github-release-payload-patterns"],
    requiredArtifactCount: payload.inputs["required-artifact-count"],
    publishArtifactKind: payload.inputs["publish-artifact-kind"],
    publishPackageMain: payload.inputs["publish-package-main"],
    runtimeSha: admission.runtime.sha,
    outputDir: ".buildchain/release-candidate",
    waitSeconds: payload.inputs["release-candidate-wait-seconds"],
  });
  if (!candidate.enabled)
    fail(candidate.reason || "release candidate is unavailable");
  const runtimeTree = execFileSync(
    "git",
    ["-C", ".buildchain/candidate", "rev-parse", "HEAD^{tree}"],
    { encoding: "utf8" },
  ).trim();
  const actionInputs = {
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    "mutation-token":
      process.env.BUILDCHAIN_PROMOTION_TOKEN || process.env.GH_TOKEN,
    repository,
    "source-sha": route.requestedSha,
    version: candidate.version,
    tag: `v${candidate.version}`,
    channel: route.channel,
    "target-ref": route.targetRef,
    "target-sha": route.requestedSha,
    "candidate-passport-path": candidate.paths.passport,
    "candidate-build-summary-path": candidate.paths.buildSummary,
    "stage-capsules-path": candidate.paths.stageCapsules,
    "publication-qualification-path": candidate.paths.publicationQualification,
    "sealed-bundle-root": candidate.paths.sealedBundleRoot,
    "sealed-bundle-manifest": candidate.paths.sealedBundleManifest,
    "required-artifacts-path": candidate.paths.publishRequiredArtifacts,
    "publisher-workflow-sha": admission.runtime.sha,
    "runtime-commit": admission.runtime.sha,
    "runtime-tree": runtimeTree,
    "required-status-check": payload.inputs["required-status-check"],
    "publish-command": payload.inputs["publish-command"],
    "publish-mode": payload.inputs["publish-mode"],
    "publish-dist-tag": payload.inputs["publish-dist-tag"],
    "publish-package-set-order": payload.inputs["publish-package-set-order"],
    "publish-package-main": payload.inputs["publish-package-main"],
    "publish-auth": payload.inputs["trusted-publishing"]
      ? "trusted-publishing"
      : "npm-token",
    "publish-rematerialize-on-resume":
      payload.inputs["publish-rematerialize-on-resume"],
    "publish-transaction-override":
      payload.inputs["publish-transaction-override"],
    "artifact-paths": candidate.paths.releaseAssets.join("\n"),
    "state-path": ".buildchain/release-tail/state.json",
    "failure-after-capability":
      payload.inputs["provider-failure-after-capability"],
  };
  const actionOutput = path.resolve(".buildchain/universal-release-action.out");
  fs.mkdirSync(path.dirname(actionOutput), { recursive: true });
  fs.writeFileSync(actionOutput, "");
  execFileSync(
    process.execPath,
    [
      path.resolve(
        ".buildchain/candidate/actions/v4-release-candidate-promote/dist/index.js",
      ),
    ],
    { env: actionEnvironment(actionInputs, actionOutput), stdio: "inherit" },
  );
  return {
    route,
    candidate: {
      runId: candidate.run.id,
      sourceSha: candidate.artifacts.sourceSha,
      version: candidate.version,
    },
    provider: readGitHubOutputs(actionOutput),
    release: verifiedReleaseDocuments(),
  };
}

async function capabilityResult(request, admission) {
  if (request.capability.id === "bootstrap-conformance")
    return executeBootstrapConformance(request, admission);
  if (request.capability.id === "release-invocation") {
    const release = createV4ReleaseInvocation(request.payload);
    return {
      releaseInvocation: release.invocation,
      releaseRoots: release.roots,
    };
  }
  if (request.capability.id === "release-candidate-promote")
    return executeReleasePromotion(request, admission);
  fail(`candidate capability is not implemented: ${request.capability.id}`);
}

async function executeCandidate(request, admission) {
  const runtime = exactRuntime(admission);
  if (v4UniversalWorkflowRequestRoot(request) !== admission.requestRoot)
    fail("candidate request does not match the admitted request root");
  const engineSha = String(process.env.BUILDCHAIN_UNIVERSAL_ENGINE_SHA || "")
    .trim()
    .toLowerCase();
  if (engineSha !== runtime.sha)
    fail("candidate engine checkout does not match the admitted runtime SHA");
  try {
    return {
      status: "succeeded",
      output: await capabilityResult(request, admission),
    };
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: String(error?.code || "candidate-execution-failed"),
        message: "candidate capability execution failed",
      },
    };
  }
}

function assertResultLineage(admission, result) {
  if (
    result?.schema !== "kungfu-buildchain-v4-universal-workflow-result/v1" ||
    result.requestRoot !== admission.requestRoot ||
    result.capabilityRoot !== admission.capabilityRoot ||
    result.runtime?.repository !== admission.runtime?.repository ||
    result.runtime?.sha !== admission.runtime?.sha ||
    !["succeeded", "failed"].includes(result.status)
  )
    fail("candidate result does not match the admitted lineage");
}

const command = process.argv[2];
if (!command) fail("a command is required");

if (command === "inspect") {
  const request = validateV4UniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  emit({
    schema: "kungfu-buildchain-v4-universal-workflow-inspection/v1",
    requestRoot: v4UniversalWorkflowRequestRoot(request),
    candidate: request.candidate,
    consumer: request.consumer,
    capability: request.capability,
  });
} else if (command === "admit") {
  emit(
    admitV4UniversalWorkflow({
      request: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
      policy: readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_POLICY_JSON"),
      observedRefSha: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_SHA,
      observedConsumerRepository:
        process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_REPOSITORY,
      observedConsumerSha: process.env.BUILDCHAIN_UNIVERSAL_CONSUMER_SHA,
      reviewEvidence: readJsonEnvironment(
        "BUILDCHAIN_UNIVERSAL_REVIEW_EVIDENCE_JSON",
      ),
      now: process.env.BUILDCHAIN_UNIVERSAL_OBSERVED_AT,
    }),
  );
} else if (command === "execute") {
  const request = validateV4UniversalWorkflowRequest(
    readJsonEnvironment("BUILDCHAIN_UNIVERSAL_REQUEST_JSON"),
  );
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const runtime = exactRuntime(admission);
  const execution = await executeCandidate(request, admission);
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: execution.status,
    requestRoot: admission.requestRoot,
    runtime,
    capabilityRoot: admission.capabilityRoot,
    enginePath: "scripts/v4-universal-workflow-engine.mjs",
    ...execution,
  };
  emit({
    ...result,
    resultRoot: contentRoot("universal-workflow-result", result),
  });
} else if (command === "terminal") {
  const admission = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_ADMISSION_JSON");
  const result = readJsonEnvironment("BUILDCHAIN_UNIVERSAL_RESULT_JSON");
  assertResultLineage(admission, result);
  emit(
    completeV4UniversalWorkflow({
      admission,
      status: result.status,
      resultRoot: result.resultRoot,
    }),
  );
} else {
  fail(`unsupported command: ${command}`);
}
