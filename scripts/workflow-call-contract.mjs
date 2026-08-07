#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { evaluateWorkflowCallContract } from "../packages/core/workflow-call-contract.js";
import { parseWorkflowDocument } from "../packages/core/workflow-yaml-contract.js";

export const SELF_RELEASE_REF = "4524c40e97dd7f7f89a6fd2020b9aa89c1cc7f82";
export const SELF_RELEASE_PUBLIC_WORKFLOW = `kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@${SELF_RELEASE_REF}`;

function parityFailure(message) {
  throw new Error(`self-release route parity: ${message}`);
}

function literal(job, name) {
  const value = job?.with?.[name];
  if (!value || value.kind === "expression") {
    parityFailure(`${job?.id || "<missing>"}.${name} must be a literal`);
  }
  return value.value;
}

export function selfReleaseRouteIdentity(workflowText, jobId = "promote") {
  const job = parseWorkflowDocument(workflowText).callJobs.find(
    (entry) => entry.id === jobId,
  );
  if (!job) parityFailure(`reusable workflow job is missing: ${jobId}`);
  if (
    job.uses.startsWith("./") ||
    job.uses.includes("/.release-candidate-promote.yml@")
  ) {
    parityFailure(
      `authoritative caller uses an internal or checkout-relative route: ${job.uses}`,
    );
  }
  if (job.uses !== SELF_RELEASE_PUBLIC_WORKFLOW) {
    parityFailure(
      `caller uses ${job.uses}, expected ${SELF_RELEASE_PUBLIC_WORKFLOW}`,
    );
  }
  if (literal(job, "buildchain-ref") !== SELF_RELEASE_REF) {
    parityFailure("caller runtime ref differs from the public workflow ref");
  }
  if (literal(job, "declarative-release-tail") !== true) {
    parityFailure(
      "caller does not require the declarative release-tail provider plane",
    );
  }
  return {
    publicWorkflow: job.uses,
    runtimeRef: SELF_RELEASE_REF,
    declarationContract: "kungfu-buildchain-release-tail-capabilities/v1",
    declarationCompiler:
      "packages/core/release-tail-provider-plane.js#compileReleaseTailDeclaration",
    transaction:
      "packages/core/release-tail-provider-plane.js#executeReleaseTailTransaction",
    providerAdapter:
      "packages/core/release-tail-provider-adapters.js#createGitHubReleaseAssetsAdapter",
    receiptValidator:
      "packages/core/release-tail-provider-plane.js#validateReleaseTailTransaction",
  };
}

export function assertSelfReleaseRouteParity({
  selfWorkflowText,
  consumerWorkflowText,
  routing,
  publicWorkflowText,
  advancedWorkflowText,
  actionText,
  providerPlanText,
} = {}) {
  const self = selfReleaseRouteIdentity(selfWorkflowText);
  const consumer = selfReleaseRouteIdentity(consumerWorkflowText);
  if (JSON.stringify(self) !== JSON.stringify(consumer)) {
    parityFailure(
      "Buildchain self-release and representative consumer identities differ",
    );
  }
  const alphaShellRef = routing?.alpha?.callRef;
  if (alphaShellRef !== "train/v3/v3.0/consumer-equivalent-self-dogfood") {
    parityFailure(
      "alpha workflow shell does not resolve through the self-dogfood train",
    );
  }
  for (const required of [
    "uses: kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@train/v3/v3.0/consumer-equivalent-self-dogfood",
    "declarative-release-tail: ${{ inputs.declarative-release-tail }}",
  ]) {
    if (!publicWorkflowText.includes(required)) {
      parityFailure(`public router is missing: ${required}`);
    }
  }
  for (const required of [
    "declarative-release-tail:",
    "declarative-release-tail: ${{ inputs.declarative-release-tail }}",
    "release-tail-transaction-root:",
  ]) {
    if (!advancedWorkflowText.includes(required)) {
      parityFailure(`advanced workflow shell is missing: ${required}`);
    }
  }
  for (const required of [
    "executeReleaseTailTransaction",
    "createGitHubReleaseAssetsAdapter",
    "publishDeclarativeGitHubReleaseEvidence",
  ]) {
    if (!actionText.includes(required)) {
      parityFailure(
        `promotion action is missing provider-plane identity: ${required}`,
      );
    }
  }
  for (const required of [
    "compileReleaseTailDeclaration",
    "githubReleaseAssetsTargetRoot",
    "createDeclarativeGitHubReleasePlan",
  ]) {
    if (!providerPlanText.includes(required)) {
      parityFailure(`declarative GitHub Release plan is missing: ${required}`);
    }
  }
  return {
    schema: "kungfu.buildchain.self-release-route-parity/v1",
    ok: true,
    self,
    consumer,
    workflowShellRef: routing.alpha.callRef,
  };
}

export function checkSelfReleaseRouteParity({ root, observed = {} } = {}) {
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  const report = assertSelfReleaseRouteParity({
    selfWorkflowText: read(".github/workflows/buildchain-ref-promotion.yml"),
    consumerWorkflowText: read(
      "tests/fixtures/self-release-route/external-consumer.yml",
    ),
    routing: JSON.parse(read(".buildchain/promotion-shell-routing.json")),
    publicWorkflowText: read(".github/workflows/release-candidate-promote.yml"),
    advancedWorkflowText: read(
      ".github/workflows/.release-candidate-promote.yml",
    ),
    actionText: `${read("actions/promote-buildchain-ref/index.js")}\n${read("actions/promote-buildchain-ref/github-release.js")}`,
    providerPlanText: read("actions/promote-buildchain-ref/github-release.js"),
  });
  const rootPattern = /^sha256:[0-9a-f]{64}$/u;
  const shaPattern = /^[0-9a-f]{40}$/u;
  for (const [name, value] of Object.entries(observed)) {
    if (!value) continue;
    const valid =
      name === "runtimeSha" ? shaPattern.test(value) : rootPattern.test(value);
    if (!valid)
      parityFailure(`observed ${name} is not an exact rooted identity`);
  }
  return { ...report, observed };
}

function usage() {
  return `usage:
  node scripts/workflow-call-contract.mjs check \\
  --caller-workflow <path> --job <id> --caller-repository <owner/repo> \\
  --callee-root <checkout> --callee-workflow <path> --callee-repository <owner/repo> \\
  --trusted-event <event[:type]> [--trusted-event ...] \\
  [--expected-contract-root sha256:...] [--allow-dirty] [--output <path>]
  node scripts/workflow-call-contract.mjs self-release-parity \\
  [--root <checkout>] [--runtime-sha <sha>] [--contract-root <root>] \\
  [--release-tail-declaration-root <root>] [--release-tail-transaction-root <root>] \\
  [--release-tail-state-root <root>] [--output <path>]`;
}

function parseArgs(argv) {
  const options = { trustedEvents: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= argv.length)
      throw new Error(`invalid argument: ${arg}`);
    const value = argv[index + 1];
    index += 1;
    if (arg === "--trusted-event") options.trustedEvents.push(value);
    else
      options[
        arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      ] = value;
  }
  return options;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function required(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw new Error(`missing required options: ${missing.join(", ")}`);
}

export function checkWorkflowCall(options) {
  const callerRoot = path.resolve(options.callerRoot || process.cwd());
  const calleeRoot = path.resolve(options.calleeRoot);
  const callerStatus = git(
    callerRoot,
    "status",
    "--porcelain",
    "--untracked-files=no",
  );
  if (callerStatus && !options.allowDirty) {
    throw new Error(
      "caller checkout is dirty; use --allow-dirty only for local diagnostic validation",
    );
  }
  const calleeStatus = git(
    calleeRoot,
    "status",
    "--porcelain",
    "--untracked-files=no",
  );
  if (calleeStatus) {
    throw new Error(
      "callee checkout is dirty; exact pinned-ref bytes are required",
    );
  }
  const callerSha = git(callerRoot, "rev-parse", "HEAD");
  const callerTree = git(callerRoot, "rev-parse", "HEAD^{tree}");
  const calleeSha = git(calleeRoot, "rev-parse", "HEAD");
  const report = evaluateWorkflowCallContract({
    callerText: fs.readFileSync(
      path.join(callerRoot, options.callerWorkflow),
      "utf8",
    ),
    calleeText: fs.readFileSync(
      path.join(calleeRoot, options.calleeWorkflow),
      "utf8",
    ),
    callerRepository: options.callerRepository,
    callerWorkflowPath: options.callerWorkflow,
    callerSha,
    callerTree,
    callerSourceState: callerStatus ? "diagnostic-dirty" : "clean",
    calleeRepository: options.calleeRepository,
    calleeWorkflowPath: options.calleeWorkflow,
    calleeSha,
    jobId: options.job,
    trustedEventClasses: options.trustedEvents,
    expectedContractRoot: options.expectedContractRoot || "",
  });
  if (options.output) {
    const output = path.resolve(callerRoot, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const options = parseArgs(argv);
  if (command === "self-release-parity") {
    const root = options.root ? path.resolve(options.root) : process.cwd();
    const report = checkSelfReleaseRouteParity({
      root,
      observed: {
        runtimeSha: options.runtimeSha || "",
        contractRoot: options.contractRoot || "",
        releaseTailDeclarationRoot: options.releaseTailDeclarationRoot || "",
        releaseTailTransactionRoot: options.releaseTailTransactionRoot || "",
        releaseTailStateRoot: options.releaseTailStateRoot || "",
      },
    });
    if (options.output) {
      const output = path.resolve(root, options.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command !== "check") throw new Error(usage());
  required(options, [
    "callerWorkflow",
    "job",
    "callerRepository",
    "calleeRoot",
    "calleeWorkflow",
    "calleeRepository",
  ]);
  if (!options.trustedEvents.length)
    throw new Error("at least one --trusted-event is required");
  const report = checkWorkflowCall(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`workflow call contract: ${error.message}`);
    process.exitCode = 1;
  }
}
