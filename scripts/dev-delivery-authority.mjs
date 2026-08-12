#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { acquireDevDeliveryLandingWarrant, acquireDevDeliveryQualificationLease, admitDevDeliveryMergeGroup, completeDevDeliveryQualification, createDevDeliveryAuthorityState, migrateDevDeliveryAuthorityState, observeDevDeliveryAuthorityState, settleDevDeliveryAuthorityCandidate, submitDevDeliveryAuthorityCandidate } from "../packages/core/dev-delivery-authority.js";
import { GitHubDevDeliveryStore } from "./dev-delivery-warrant.mjs";

const STATE_REF_PREFIX = "buildchain/dev-delivery-authority/";

function text(value = "") {
  return String(value ?? "").trim();
}

function positiveInteger(value, label, fallback = 0) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("repository must be owner/repo");
  }
  return normalized;
}

function branch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error("branch must be dev/vN/vN.M");
  }
  return normalized;
}

export function defaultDevDeliveryAuthorityStateRef(value) {
  return `${STATE_REF_PREFIX}${branch(value).replaceAll("/", "-")}`;
}

function stateRef(value, protectedBranch) {
  const normalized = text(value || defaultDevDeliveryAuthorityStateRef(protectedBranch)).replace(/^refs\/heads\//, "");
  if (!normalized.startsWith(STATE_REF_PREFIX) || normalized.includes("..")) {
    throw new Error(`state ref must remain under ${STATE_REF_PREFIX}`);
  }
  return normalized;
}

function identity(state, options) {
  return {
    candidateId: options.candidateId,
    token: options.authorityToken,
    generation: options.authorityGeneration,
  };
}

function transitionFor(command, state, options) {
  if (command === "migrate") {
    if (!options.legacyState) {
      throw new Error("migrate requires --legacy-state <v1-queue.json>");
    }
    return migrateDevDeliveryAuthorityState(options.legacyState, {
      now: options.now,
      policy: state.policy,
    });
  }
  if (command === "submit") {
    return submitDevDeliveryAuthorityCandidate(
      state,
      {
        pullRequestNumber: options.pullRequestNumber,
        sourceHead: options.sourceHead,
        assignmentRoot: options.assignmentRoot,
        initiativeRoot: options.initiativeRoot,
        sourceIdentityRoot: options.sourceIdentityRoot,
        sourcePatchRoot: options.sourcePatchRoot,
        sourceProofRoot: options.sourceProofRoot,
        planRoot: options.planRoot,
        closureRoot: options.closureRoot,
        dependencyRoot: options.dependencyRoot,
        toolchainRoot: options.toolchainRoot,
        deliveryClass: options.deliveryClass,
      },
      { now: options.now },
    );
  }
  if (command === "lease-qualification") {
    return acquireDevDeliveryQualificationLease(state, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "complete-qualification") {
    return completeDevDeliveryQualification(state, identity(state, options), {
      evidenceRoot: options.evidenceRoot,
      now: options.now,
    });
  }
  if (command === "lease-landing") {
    return acquireDevDeliveryLandingWarrant(state, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "settle") {
    return settleDevDeliveryAuthorityCandidate(
      state,
      {
        pullRequestNumber: options.pullRequestNumber,
        sourceHead: options.sourceHead,
        outcome: options.outcome,
        evidenceRoot: options.evidenceRoot,
        reason: options.reason,
        authorityToken: options.authorityToken,
        authorityGeneration: options.authorityGeneration,
      },
      { now: options.now },
    );
  }
  throw new Error(`unsupported dev authority command ${command || "<empty>"}`);
}

export async function runDevDeliveryAuthorityCommand(optionsInput = {}, clientInput) {
  const options = {
    ...optionsInput,
    repository: repository(optionsInput.repository),
    branch: branch(optionsInput.branch),
    now: new Date(optionsInput.now || Date.now()).toISOString(),
    execute: bool(optionsInput.execute),
  };
  options.stateRef = stateRef(optionsInput.stateRef, options.branch);
  const store =
    clientInput ||
    new GitHubDevDeliveryStore({
      repository: options.repository,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl: options.apiUrl || process.env.GITHUB_API_URL || "https://api.github.com",
      createInitialState: ({ repository: repositoryInput, protectedBase, now }) =>
        createDevDeliveryAuthorityState({
          repository: repositoryInput,
          protectedBase,
          policy: {
            maxQualificationLeases: positiveInteger(options.maxQualificationLeases, "maxQualificationLeases", 2),
            qualificationLeaseSeconds: positiveInteger(options.qualificationLeaseSeconds, "qualificationLeaseSeconds", 3600),
            landingLeaseSeconds: positiveInteger(options.landingLeaseSeconds, "landingLeaseSeconds", 900),
          },
          now,
        }),
    });
  const loaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
  });
  if (options.command === "migrate" && loaded.exists) {
    throw new Error("migration target state ref already exists");
  }
  if (options.expectedOldStateRoot && loaded.queue.stateRoot !== options.expectedOldStateRoot) {
    throw new Error(`expected-old state drift: ${loaded.queue.stateRoot} != ${options.expectedOldStateRoot}`);
  }
  if (options.command === "observe") {
    return {
      schema: "kungfu.buildchain.dev-delivery-authority-command-result/v1",
      ok: true,
      mode: "observe",
      stateRef: options.stateRef,
      stateCommit: loaded.commitSha,
      observation: observeDevDeliveryAuthorityState(loaded.queue, {
        now: options.now,
      }),
    };
  }
  if (options.command === "admit-merge-group") {
    const admitted = admitDevDeliveryMergeGroup(loaded.queue, identity(loaded.queue, options), { mergeGroupHead: options.mergeGroupHead, now: options.now });
    return {
      schema: "kungfu.buildchain.dev-delivery-authority-command-result/v1",
      ok: true,
      mode: "admission-check",
      command: options.command,
      stateRef: options.stateRef,
      before: {
        commitSha: loaded.commitSha,
        stateRoot: loaded.queue.stateRoot,
      },
      after: { commitSha: loaded.commitSha, stateRoot: loaded.queue.stateRoot },
      mutationAuthorized: false,
      mutationApplied: false,
      ...admitted,
      observation: observeDevDeliveryAuthorityState(loaded.queue, {
        now: options.now,
      }),
    };
  }
  if (options.legacyStatePath) {
    options.legacyState = JSON.parse(fs.readFileSync(path.resolve(options.legacyStatePath), "utf8"));
  }
  const changed = transitionFor(options.command, loaded.queue, options);
  if (changed.state.repository !== options.repository || changed.state.protectedBase !== options.branch) {
    throw new Error("authority transition repository or protected base drift");
  }
  const mutates = changed.state.stateRoot !== loaded.queue.stateRoot;
  let write = null;
  if (options.execute && mutates) {
    if (options.command !== "migrate" && changed.receipt.expectedOldStateRoot !== loaded.queue.stateRoot) {
      throw new Error("transition expected-old root does not match loaded authority");
    }
    write = await store.write({
      stateRef: options.stateRef,
      queue: changed.state,
      expectedCommitSha: loaded.commitSha,
      expectedStateRoot: loaded.queue.stateRoot,
      receiptRoot: changed.receiptRoot,
    });
  }
  return {
    schema: "kungfu.buildchain.dev-delivery-authority-command-result/v1",
    ok: true,
    mode: options.execute ? "execute" : "plan",
    command: options.command,
    stateRef: options.stateRef,
    before: { commitSha: loaded.commitSha, stateRoot: loaded.queue.stateRoot },
    after: {
      commitSha: write?.commitSha || loaded.commitSha,
      stateRoot: changed.state.stateRoot,
    },
    mutationAuthorized: options.execute,
    mutationApplied: Boolean(write),
    receipt: changed.receipt,
    receiptRoot: changed.receiptRoot,
    lease: changed.lease || null,
    warrant: changed.warrant || changed.state.landingWarrant || null,
    observation: observeDevDeliveryAuthorityState(changed.state, {
      now: options.now,
    }),
  };
}

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function devDeliveryAuthorityCliOptions(args = [], environment = process.env) {
  const [command = "", ...rest] = args;
  return {
    command,
    repository: flag(rest, "repository", environment.GITHUB_REPOSITORY),
    branch: flag(rest, "branch", environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF),
    stateRef: flag(rest, "state-ref", environment.BUILDCHAIN_DEV_AUTHORITY_STATE_REF),
    expectedOldStateRoot: flag(rest, "expected-old", environment.BUILDCHAIN_DEV_AUTHORITY_EXPECTED_OLD),
    pullRequestNumber: flag(rest, "pull-request", environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER),
    candidateId: flag(rest, "candidate-id", environment.BUILDCHAIN_DEV_DELIVERY_CANDIDATE_ID),
    sourceHead: flag(rest, "source-head", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD),
    assignmentRoot: flag(rest, "assignment-root", environment.BUILDCHAIN_DEV_DELIVERY_ASSIGNMENT_ROOT),
    initiativeRoot: flag(rest, "initiative-root", environment.BUILDCHAIN_DEV_DELIVERY_INITIATIVE_ROOT),
    sourceIdentityRoot: flag(rest, "source-identity-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT),
    sourcePatchRoot: flag(rest, "source-patch-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT),
    sourceProofRoot: flag(rest, "source-proof-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF_ROOT),
    planRoot: flag(rest, "plan-root", environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT),
    closureRoot: flag(rest, "closure-root", environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT),
    dependencyRoot: flag(rest, "dependency-root", environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT),
    toolchainRoot: flag(rest, "toolchain-root", environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT),
    legacyStatePath: flag(rest, "legacy-state", environment.BUILDCHAIN_DEV_AUTHORITY_LEGACY_STATE),
    deliveryClass: flag(rest, "delivery-class", environment.BUILDCHAIN_DEV_DELIVERY_CLASS),
    authorityToken: flag(rest, "authority-token", environment.BUILDCHAIN_DEV_AUTHORITY_TOKEN),
    authorityGeneration: flag(rest, "authority-generation", environment.BUILDCHAIN_DEV_AUTHORITY_GENERATION),
    evidenceRoot: flag(rest, "evidence-root", environment.BUILDCHAIN_DEV_DELIVERY_EVIDENCE_ROOT),
    mergeGroupHead: flag(rest, "merge-group-head", environment.BUILDCHAIN_DEV_MERGE_GROUP_HEAD),
    outcome: flag(rest, "outcome", environment.BUILDCHAIN_DEV_DELIVERY_OUTCOME),
    reason: flag(rest, "reason", environment.BUILDCHAIN_DEV_DELIVERY_REASON),
    leaseSeconds: flag(rest, "lease-seconds", environment.BUILDCHAIN_DEV_AUTHORITY_LEASE_SECONDS),
    maxQualificationLeases: flag(rest, "max-qualification-leases", environment.BUILDCHAIN_DEV_MAX_QUALIFICATION_LEASES || "2"),
    qualificationLeaseSeconds: flag(rest, "qualification-lease-seconds", environment.BUILDCHAIN_DEV_QUALIFICATION_LEASE_SECONDS || "3600"),
    landingLeaseSeconds: flag(rest, "landing-lease-seconds", environment.BUILDCHAIN_DEV_LANDING_LEASE_SECONDS || "900"),
    now: flag(rest, "now", environment.BUILDCHAIN_DEV_DELIVERY_NOW),
    outputPath: flag(rest, "output", environment.BUILDCHAIN_DEV_DELIVERY_OUTPUT || ".buildchain/dev-delivery/authority-result.json"),
    execute: hasFlag(rest, "execute"),
    json: hasFlag(rest, "json"),
  };
}

function usage() {
  return "Usage: buildchain dev authority <migrate|submit|lease-qualification|complete-qualification|lease-landing|admit-merge-group|settle|observe> --repository <owner/repo> --branch <dev/vN/vN.M> [--legacy-state <v1-queue.json>] [--execute] [--output <file>] [--json]\n";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || hasFlag(args, "help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryAuthorityCliOptions(args);
  if (!["submit", "migrate", "lease-qualification", "complete-qualification", "lease-landing", "admit-merge-group", "settle", "observe"].includes(options.command)) {
    throw new Error(usage().trim());
  }
  const result = await runDevDeliveryAuthorityCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Buildchain dev authority ${options.command}: ${result.mode}\nResult: ${options.outputPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev authority: ${error.message}`);
    process.exit(1);
  });
}
