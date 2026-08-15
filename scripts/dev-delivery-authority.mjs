#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createDevDeliveryAuthorityState,
  observeDevDeliveryAuthorityState,
} from "../packages/core/dev-delivery-authority-landing.js";
import { defaultDevDeliveryStateRef } from "./dev-delivery-warrant.mjs";
import { GitHubDevDeliveryStore } from "./dev-delivery-warrant.mjs";
import { flag, hasFlag } from "./dev-delivery-warrant-options.mjs";
import { runDevDeliveryAuthorityCommandAdapter } from "./dev-delivery-authority-command-adapters.mjs";
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
function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value === undefined || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
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
  return defaultDevDeliveryStateRef(branch(value));
}
function stateRef(value, protectedBranch) {
  const expected = defaultDevDeliveryAuthorityStateRef(protectedBranch);
  const normalized = text(value || expected).replace(/^refs\/heads\//, "");
  if (normalized !== expected) {
    throw new Error(
      `state ref must be the canonical authority ref ${expected}`,
    );
  }
  return normalized;
}
function normalizedAuthorityOptions(optionsInput) {
  const options = {
    ...optionsInput,
    repository: repository(optionsInput.repository),
    branch: branch(optionsInput.branch),
    now: new Date(optionsInput.now || Date.now()).toISOString(),
    execute: bool(optionsInput.execute),
  };
  options.stateRef = stateRef(optionsInput.stateRef, options.branch);
  return options;
}

function createAuthorityStore(options, clientInput) {
  return (
    clientInput ||
    new GitHubDevDeliveryStore({
      repository: options.repository,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl:
        options.apiUrl ||
        process.env.GITHUB_API_URL ||
        "https://api.github.com",
      createInitialState: ({
        repository: repositoryInput,
        protectedBase,
        now,
      }) =>
        createDevDeliveryAuthorityState({
          repository: repositoryInput,
          protectedBase,
          policy: {
            maxQualificationLeases: positiveInteger(
              options.maxQualificationLeases,
              "maxQualificationLeases",
              2,
            ),
            qualificationLeaseSeconds: positiveInteger(
              options.qualificationLeaseSeconds,
              "qualificationLeaseSeconds",
              3600,
            ),
            landingLeaseSeconds: positiveInteger(
              options.landingLeaseSeconds,
              "landingLeaseSeconds",
              900,
            ),
            maxLandingOvertakes: nonNegativeInteger(
              options.maxLandingOvertakes,
              "maxLandingOvertakes",
              2,
            ),
            maxQualificationAttempts: positiveInteger(
              options.maxQualificationAttempts,
              "maxQualificationAttempts",
              3,
            ),
          },
          now,
        }),
    })
  );
}

function assertAuthorityTransitionScope(changed, options) {
  if (
    changed.state.repository !== options.repository ||
    changed.state.protectedBase !== options.branch
  ) {
    throw new Error("authority transition repository or protected base drift");
  }
}

async function writeAuthorityTransition(store, loaded, changed, options) {
  const mutates = changed.state.stateRoot !== loaded.queue.stateRoot;
  if (!options.execute || !mutates) return null;
  if (options.command === "migrate") {
    const currentSource = await store.read({
      stateRef: options.migrationSource.stateRef,
      protectedBase: options.branch,
      now: options.now,
    });
    if (
      !currentSource.exists ||
      currentSource.commitSha !== options.migrationSource.commitSha ||
      currentSource.queue.stateRoot !== options.migrationSource.queue.stateRoot
    ) {
      throw new Error("live v1 authority changed during migration");
    }
  }
  if (
    options.command !== "migrate" &&
    changed.receipt.expectedOldStateRoot !== loaded.queue.stateRoot
  ) {
    throw new Error(
      "transition expected-old root does not match loaded authority",
    );
  }
  return store.write({
    stateRef: options.stateRef,
    queue: changed.state,
    expectedCommitSha: loaded.commitSha,
    expectedStateRoot: loaded.queue.stateRoot,
    receiptRoot: changed.receiptRoot,
  });
}

function authorityCommandResult({ loaded, changed, write, options }) {
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
    migrationSource: options.migrationSource
      ? {
          stateRef: options.migrationSource.stateRef,
          commitSha: options.migrationSource.commitSha,
          stateRoot: options.migrationSource.queue.stateRoot,
        }
      : null,
  };
}

export async function runDevDeliveryAuthorityCommand(
  optionsInput = {},
  clientInput,
) {
  const options = normalizedAuthorityOptions(optionsInput);
  const store = createAuthorityStore(options, clientInput);
  const loaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
  });
  if (options.command === "migrate") {
    if (!loaded.exists) {
      throw new Error(
        `live v1 authority state ref ${options.stateRef} is missing`,
      );
    }
    options.migrationSource = {
      ...loaded,
      stateRef: options.stateRef,
    };
  }
  const operation = await runDevDeliveryAuthorityCommandAdapter(
    loaded,
    options,
  );
  if (operation.result) return operation.result;
  assertAuthorityTransitionScope(operation.changed, options);
  const write = await writeAuthorityTransition(
    store,
    loaded,
    operation.changed,
    options,
  );
  return authorityCommandResult({
    loaded,
    changed: operation.changed,
    write,
    options,
  });
}
export function devDeliveryAuthorityCliOptions(
  args = [],
  environment = process.env,
) {
  const [command = "", ...rest] = args;
  return {
    command,
    repository: flag(rest, "repository", environment.GITHUB_REPOSITORY),
    branch: flag(
      rest,
      "branch",
      environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF,
    ),
    stateRef: flag(
      rest,
      "state-ref",
      environment.BUILDCHAIN_DEV_AUTHORITY_STATE_REF,
    ),
    expectedOldStateRoot: flag(
      rest,
      "expected-old",
      environment.BUILDCHAIN_DEV_AUTHORITY_EXPECTED_OLD,
    ),
    pullRequestNumber: flag(
      rest,
      "pull-request",
      environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER,
    ),
    candidateId: flag(
      rest,
      "candidate-id",
      environment.BUILDCHAIN_DEV_DELIVERY_CANDIDATE_ID,
    ),
    sourceHead: flag(
      rest,
      "source-head",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD,
    ),
    assignmentRoot: flag(
      rest,
      "assignment-root",
      environment.BUILDCHAIN_DEV_DELIVERY_ASSIGNMENT_ROOT,
    ),
    initiativeRoot: flag(
      rest,
      "initiative-root",
      environment.BUILDCHAIN_DEV_DELIVERY_INITIATIVE_ROOT,
    ),
    sourceIdentityRoot: flag(
      rest,
      "source-identity-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT,
    ),
    sourcePatchRoot: flag(
      rest,
      "source-patch-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT,
    ),
    sourceProofRoot: flag(
      rest,
      "source-proof-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF_ROOT,
    ),
    planRoot: flag(
      rest,
      "plan-root",
      environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT,
    ),
    closureRoot: flag(
      rest,
      "closure-root",
      environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT,
    ),
    dependencyRoot: flag(
      rest,
      "dependency-root",
      environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT,
    ),
    toolchainRoot: flag(
      rest,
      "toolchain-root",
      environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT,
    ),
    environmentRoot: flag(
      rest,
      "environment-root",
      environment.BUILDCHAIN_DEV_DELIVERY_ENVIRONMENT_ROOT,
    ),
    affectedPaths: flag(
      rest,
      "affected-paths-json",
      environment.BUILDCHAIN_DEV_DELIVERY_AFFECTED_PATHS || "[]",
    ),
    shardEvidenceRoots: flag(
      rest,
      "shard-evidence-roots-json",
      environment.BUILDCHAIN_DEV_DELIVERY_SHARD_EVIDENCE_ROOTS || "[]",
    ),
    nativeCommand: flag(
      rest,
      "native-command",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND,
    ),
    nativeCommandRoot: flag(
      rest,
      "native-command-root",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND_ROOT,
    ),
    sourceProofPath: flag(
      rest,
      "source-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF,
    ),
    nativeProofPath: flag(
      rest,
      "native-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_PROOF,
    ),
    qualificationContractPath: flag(
      rest,
      "qualification-contract",
      environment.BUILDCHAIN_DEV_QUALIFICATION_CONTRACT,
    ),
    providerAttemptPath: flag(
      rest,
      "provider-attempt",
      environment.BUILDCHAIN_DEV_LANDING_PROVIDER_ATTEMPT,
    ),
    deliveryClass: flag(
      rest,
      "delivery-class",
      environment.BUILDCHAIN_DEV_DELIVERY_CLASS,
    ),
    qualificationDomains: flag(
      rest,
      "qualification-domains",
      environment.BUILDCHAIN_DEV_QUALIFICATION_DOMAINS || "[]",
    ),
    authorityToken: flag(
      rest,
      "authority-token",
      environment.BUILDCHAIN_DEV_AUTHORITY_TOKEN,
    ),
    authorityGeneration: flag(
      rest,
      "authority-generation",
      environment.BUILDCHAIN_DEV_AUTHORITY_GENERATION,
    ),
    providerRunId: environment.GITHUB_RUN_ID,
    providerRunAttempt: environment.GITHUB_RUN_ATTEMPT,
    transferRoot: flag(rest, "transfer-root"),
    finalizerBoundaryRoot: flag(rest, "finalizer-boundary-root"),
    nativeJobId: flag(rest, "native-job-id"),
    sealJobId: flag(rest, "seal-job-id"),
    evidenceRoot: flag(
      rest,
      "evidence-root",
      environment.BUILDCHAIN_DEV_DELIVERY_EVIDENCE_ROOT,
    ),
    mergeGroupHead: flag(
      rest,
      "merge-group-head",
      environment.BUILDCHAIN_DEV_MERGE_GROUP_HEAD,
    ),
    outcome: flag(rest, "outcome", environment.BUILDCHAIN_DEV_DELIVERY_OUTCOME),
    reason: flag(rest, "reason", environment.BUILDCHAIN_DEV_DELIVERY_REASON),
    leaseSeconds: flag(
      rest,
      "lease-seconds",
      environment.BUILDCHAIN_DEV_AUTHORITY_LEASE_SECONDS,
    ),
    maxQualificationLeases: flag(
      rest,
      "max-qualification-leases",
      environment.BUILDCHAIN_DEV_MAX_QUALIFICATION_LEASES || "2",
    ),
    qualificationLeaseSeconds: flag(
      rest,
      "qualification-lease-seconds",
      environment.BUILDCHAIN_DEV_QUALIFICATION_LEASE_SECONDS || "3600",
    ),
    landingLeaseSeconds: flag(
      rest,
      "landing-lease-seconds",
      environment.BUILDCHAIN_DEV_LANDING_LEASE_SECONDS || "900",
    ),
    maxLandingOvertakes: flag(
      rest,
      "max-landing-overtakes",
      environment.BUILDCHAIN_DEV_MAX_LANDING_OVERTAKES || "2",
    ),
    maxQualificationAttempts: flag(
      rest,
      "max-qualification-attempts",
      environment.BUILDCHAIN_DEV_MAX_QUALIFICATION_ATTEMPTS || "3",
    ),
    now: flag(rest, "now", environment.BUILDCHAIN_DEV_DELIVERY_NOW),
    outputPath: flag(
      rest,
      "output",
      environment.BUILDCHAIN_DEV_DELIVERY_OUTPUT ||
        ".buildchain/dev-delivery/authority-result.json",
    ),
    execute: hasFlag(rest, "execute"),
    json: hasFlag(rest, "json"),
  };
}
function usage() {
  return "Usage: buildchain dev authority <migrate|submit|lease-qualification|heartbeat-qualification|complete-qualification|lease-landing|heartbeat-landing|recover|admit-merge-group|settle|observe> --repository <owner/repo> --branch <dev/vN/vN.M> [--environment-root <root>] [--qualification-domains <json>] [--provider-attempt <admitted-attempt.json>] [--execute] [--output <file>] [--json]\n";
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || hasFlag(args, "help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryAuthorityCliOptions(args);
  if (
    ![
      "submit",
      "migrate",
      "lease-qualification",
      "heartbeat-qualification",
      "complete-qualification",
      "lease-landing",
      "heartbeat-landing",
      "recover",
      "admit-merge-group",
      "settle",
      "observe",
    ].includes(options.command)
  ) {
    throw new Error(usage().trim());
  }
  const result = await runDevDeliveryAuthorityCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(
      `Buildchain dev authority ${options.command}: ${result.mode}\nResult: ${options.outputPath}\n`,
    );
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev authority: ${error.message}`);
    process.exit(1);
  });
}
