#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlUses } from "../packages/core/workflow-yaml-contract.js";

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
    if (!block.includes("- trust-gate")) {
      fail(`.build.yml job ${job} is not directly gated by trust-gate`);
    }
  }
}

function jobDependsOn(source, job, dependency) {
  const block = workflowJobBlock(source, job);
  return new RegExp(
    `^    needs:\\s*(?:${dependency}|\\[[^\\]]*\\b${dependency}\\b[^\\]]*\\])\\s*$`,
    "mu",
  ).test(block);
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
  for (const marker of [
    ".buildchain/runtime/promotion-shell/scripts/v4-consumer-policy.mjs certify",
    '--caller-root "${{ github.workspace }}"',
    '--stable-lock "${{ inputs.buildchain-stable-contract-lock-path }}"',
    '--alpha-lock "${{ inputs.buildchain-alpha-contract-lock-path }}"',
    "release-passport-v4-consumer-policy-certification-root: ${{ steps.v4-policy-certification.outputs.v4-consumer-policy-certification-root }}",
  ]) {
    if (!source.includes(marker)) {
      fail(`promotion certification is missing ${marker}`);
    }
  }
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
      const isV4 =
        selector === "v4" ||
        selector === "v4-alpha" ||
        /^v4(?:[./-]|$)/u.test(selector) ||
        /^[0-9a-f]{40}$/iu.test(selector) ||
        selector.includes("${{");
      if (isV4 && !["v4", "v4-alpha"].includes(selector)) {
        offenders.push(`${relative}:${node.line} @${selector}`);
      }
    }
  }
  if (offenders.length)
    fail(
      `persisted v4 selectors must be v4 or v4-alpha: ${offenders.join(", ")}`,
    );
}

export function checkV4FloatingConsumerPolicyContract() {
  const policy = JSON.parse(
    read("architecture/v4-floating-consumer-policy.json"),
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
  assertOrdered(".github/workflows/.build.yml", [
    "Enforce v4 floating consumer policy",
    "Validate consumer package manager contract",
  ]);
  assertTrustGatedJobs(read(".github/workflows/.build.yml"), [
    "resolve-source",
    "resolve-contract",
    "controller-plan",
    "artifact-transfer",
    "build-native",
    "build-linux-container",
    "summarize",
  ]);
  assertOrdered(".github/workflows/publication-artifact.yml", [
    "Enforce v4 floating consumer policy",
    "Resolve controller identities",
    "Install Buildchain runtime dependencies",
  ]);
  const stageCanary = read(".github/workflows/v4-stage-capsule-canary.yml");
  if (
    !stageCanary.includes("consumer-admission:") ||
    !stageCanary.includes("needs: consumer-admission")
  ) {
    fail(
      "Stage Capsule qualification is not transitively gated by consumer admission",
    );
  }
  const promotion = read(".github/workflows/release-candidate-promote.yml");
  if (
    !promotion.includes("consumer-admission:") ||
    !jobDependsOn(promotion, "alpha", "consumer-admission") ||
    !jobDependsOn(promotion, "stable", "consumer-admission")
  ) {
    fail(
      "release candidate promotion is not transitively gated by consumer admission",
    );
  }
  assertPromotionCertificationWiring(
    read(".github/workflows/.release-candidate-promote.yml"),
  );
  for (const [relative, marker] of [
    ["packages/core/release-candidate.js", "consumerPolicy"],
    ["packages/core/release-passport.js", "v4ConsumerPolicy"],
    [
      "actions/promote-buildchain-ref/action.yml",
      "release-passport-v4-consumer-policy-certification-json",
    ],
    [
      "actions/promote-buildchain-ref/action.yml",
      "release-passport-v4-consumer-policy-certification-root",
    ],
    [
      ".github/workflows/.release-candidate-promote.yml",
      "v4-policy-certification",
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
      `${JSON.stringify(checkV4FloatingConsumerPolicyContract(), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
