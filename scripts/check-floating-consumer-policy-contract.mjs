#!/usr/bin/env node
import fs from "node:fs";
import YAML from "yaml";
import { inspectWorkflowJob } from "./workflow-action-graph.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlUses } from "../packages/core/contracts/workflow-yaml-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
function fail(message) {
  throw new Error(`v4-floating-consumer-policy-contract: ${message}`);
}

export function workflowJobBlock(source, job) {
  return (
    source.match(
      new RegExp(
        `^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z0-9_-]+:|(?![\\s\\S]))`,
        "mu",
      ),
    )?.[1] || ""
  );
}

export function assertTrustGatedJobs(source, jobs) {
  for (const job of jobs) {
    const block = workflowJobBlock(source, job);
    if (!block.includes("- plan")) {
      fail(`.build.yml job ${job} is not directly gated by plan`);
    }
  }
}

function jobDependsOn(source, job, dependency) {
  const needs = YAML.parse(source)?.jobs?.[job]?.needs;
  return (Array.isArray(needs) ? needs : [needs]).includes(dependency);
}

function assertOrdered(relative, markers) {
  const source = read(relative);
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    if (next < 0) fail(`${relative} is missing ${marker}`);
    if (next <= cursor)
      fail(`${relative} does not enforce ${markers.join(" -> ")}`);
    cursor = next;
  }
}

export function assertPromotionCertificationWiring(source) {
  const workflow = YAML.parse(source);
  const node = workflow?.jobs?.qualify?.steps?.find((step) => step.id === "node");
  if (node?.uses !== "./.buildchain/workflow-shell/actions/release/promotion/qualify" ||
      node.with?.["request-json"] !== "${{ inputs.request-json }}" ||
      node.with?.["job-workflow-sha"] !== "${{ toJSON(job.workflow_sha) }}")
    fail("promotion certification is missing its exact owned node and typed request binding");
  if (!jobDependsOn(source, "apply", "qualify")) fail("promotion certification is missing before APPLY");
}

function assertPersistedSelectors() {
  const offenders = [];
  const workflows = fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  for (const name of workflows) {
    const relative = `.github/workflows/${name}`;
    for (const node of parseYamlUses(read(relative))) {
      const match = node.value.match(
        /^kungfu-systems\/buildchain\/(.+)@(.+)$/u,
      );
      if (!match) continue;
      const selector = match[2];
      const isCurrentMajor =
        selector === "v4" ||
        selector === "v4-alpha" ||
        /^v4(?:[./-]|$)/u.test(selector) ||
        /^[0-9a-f]{40}$/iu.test(selector) ||
        selector.includes("${{");
      if (
        isCurrentMajor &&
        !["v4", "v4-alpha"].includes(selector)
      ) {
        offenders.push(`${relative}:${node.line} @${selector}`);
      }
    }
  }
  if (offenders.length)
    fail(
      `persisted v4 selectors must be v4 or v4-alpha: ${offenders.join(", ")}`,
    );
}

export function checkFloatingConsumerPolicyContract() {
  const policy = JSON.parse(
    read("architecture/floating-consumer-policy.json"),
  );
  if (policy.contract !== "kungfu-buildchain-v4-floating-consumer-policy/v1") {
    fail("architecture policy contract is missing");
  }
  if (
    policy.contractLocks?.selectedLockMustBindResolvedWorkflowShell !== true
  ) {
    fail("contract lock must bind the visible workflow shell");
  }
  assertPersistedSelectors();
  assertOrdered("packages/core/build/plan/admission.js", ["const policy = scanConsumerPolicy(", "validatePackageManagerContract({", "const lock = inspectRuntimeContract({", "assertRuntimeContractAccepted(lock)"]);
  const buildWorkflow = read(".github/workflows/.build.yml");
  const planner = read("packages/core/build/plan/admission.js");
  if (!planner.includes("expectedInvocationChannel: plan.identity.channel") ||
      !buildWorkflow.includes("workflow-sha: ${{ job.workflow_sha }}") ||
      !buildWorkflow.includes("actions/build/lifecycle/plan")) fail("build planning must bind called workflow and channel admission");
  assertTrustGatedJobs(buildWorkflow, ["build-native", "build-container", "sign", "attest", "deliver"]);
  assertOrdered("actions/publication/candidate/plan/action.yml", [
    "ref: ${{ inputs.runtime-sha }}", "Prepare exact publication runtime", "Enforce v4 floating consumer policy", "Resolve controller identities",
  ]);
  const publication = YAML.parse(read(".github/workflows/public-build-publication.yml"));
  if (!Object.values(publication.jobs).some((job) => job.steps?.some((step) => step.uses?.endsWith("/actions/publication/candidate/plan"))))
    fail("publication does not invoke its consumer policy node");
  const stageCanary = read(".github/workflows/public-build-stage-capsule-canary.yml");
  if (
    !stageCanary.includes("consumer-admission:") ||
    !stageCanary.includes("needs: consumer-admission")
  ) {
    fail(
      "Stage Capsule qualification is not transitively gated by consumer admission",
    );
  }
  const promotion = read(".github/workflows/public-release-promote.yml");
  if (
    !promotion.includes("consumer-admission:") ||
    !jobDependsOn(promotion, "invoke", "consumer-admission")
  ) {
    fail(
      "release candidate promotion is not transitively gated by consumer admission",
    );
  }
  assertPromotionCertificationWiring(
    read(".github/workflows/.release-promote.yml"),
  );
  for (const [relative, marker] of [
    ["packages/core/release/release-candidate.js", "consumerPolicy"],
    ["packages/core/release/passport/assembly-render.js", "v4ConsumerPolicy"],
    [
      "packages/core/release/promote-candidate/release-documents.js",
      "candidate.consumerPolicy?.receiptRoot",
    ],
    [
      "packages/core/release/promote-candidate/release-documents.js",
      "createReleaseInvocation",
    ],
  ]) {
    if (!read(relative).includes(marker)) {
      fail(
        `${relative} does not bind v4 consumer policy evidence marker ${marker}`,
      );
    }
  }
  const agents = read("AGENTS.md");
  for (const invariant of [
    "source-persisted exact commit SHA",
    "matching stable and alpha contract locks",
    "trusted non-persistent runtime input",
  ]) {
    if (!agents.includes(invariant))
      fail(`AGENTS.md is missing invariant: ${invariant}`);
  }
  return { ok: true, entrypoints: policy.scope.publicWorkflowEntrypoints };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(
      `${JSON.stringify(checkFloatingConsumerPolicyContract(), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
