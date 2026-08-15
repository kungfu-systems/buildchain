import fs from "node:fs";
import path from "node:path";
import {
  acquireDevDeliveryLandingWarrant,
  acquireDevDeliveryQualificationLease,
  admitDevDeliveryMergeGroup,
  completeDevDeliveryQualification,
  heartbeatDevDeliveryLandingWarrantWithGitHubProvider,
  heartbeatDevDeliveryQualificationLease,
  migrateDevDeliveryAuthorityState,
  observeDevDeliveryAuthorityState,
  recoverDevDeliveryAuthority,
  submitDevDeliveryAuthorityCandidate,
} from "../packages/core/dev-delivery-authority-landing.js";
import { createNativeCommandContract } from "../packages/core/dev-delivery-warrant.js";
import { settleDevDeliveryAuthorityWithProvider } from "./dev-delivery-authority-provider.mjs";

function identity(options) {
  return {
    candidateId: options.candidateId,
    token: options.authorityToken,
    generation: options.authorityGeneration,
  };
}

function rootedList(value) {
  if (Array.isArray(value)) return value;
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (cause) {
    throw new Error(
      `qualification domains must be a JSON array: ${cause.message}`,
    );
  }
  if (!Array.isArray(parsed))
    throw new Error("qualification domains must be a JSON array");
  return parsed;
}

function migrateAuthority(state, options) {
  if (!options.migrationSource?.exists) {
    throw new Error("migrate requires the live v1 authority state ref");
  }
  return migrateDevDeliveryAuthorityState(options.migrationSource.queue, {
    now: options.now,
    policy: state.policy,
  });
}

function submitCandidate(state, options) {
  const nativeCommandContract = options.environmentRoot
    ? options.nativeCommandContract ||
      createNativeCommandContract(options.nativeCommand)
    : undefined;
  if (
    options.nativeCommandRoot &&
    nativeCommandContract?.commandRoot !== options.nativeCommandRoot
  ) {
    throw new Error(
      "native command contract root does not match native-command",
    );
  }
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
      environmentRoot: options.environmentRoot,
      nativeCommandContract,
      affectedPaths: rootedList(options.affectedPaths),
      shardEvidenceRoots: rootedList(options.shardEvidenceRoots),
      deliveryClass: options.deliveryClass,
      qualificationDomains: rootedList(options.qualificationDomains),
    },
    { now: options.now },
  );
}

const commandAdapters = {
  migrate: migrateAuthority,
  submit: submitCandidate,
  "lease-qualification": (state, options) =>
    acquireDevDeliveryQualificationLease(state, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    }),
  "complete-qualification": (state, options) =>
    completeDevDeliveryQualification(state, identity(options), {
      sourceProof: options.sourceProof,
      nativeProof: options.nativeProof,
      qualificationContract: options.qualificationContract,
      now: options.now,
    }),
  "heartbeat-qualification": (state, options) =>
    heartbeatDevDeliveryQualificationLease(state, identity(options), {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    }),
  "lease-landing": (state, options) =>
    acquireDevDeliveryLandingWarrant(state, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    }),
  "heartbeat-landing": (state, options) =>
    heartbeatDevDeliveryLandingWarrantWithGitHubProvider(
      state,
      identity(options),
      {
        providerAttempt: options.providerAttempt,
        token: options.token || process.env.GITHUB_TOKEN,
        apiUrl:
          options.apiUrl ||
          process.env.GITHUB_API_URL ||
          "https://api.github.com",
        now: options.now,
        leaseSeconds: options.leaseSeconds,
      },
    ),
  recover: (state, options) =>
    recoverDevDeliveryAuthority(state, { now: options.now }),
  "admit-merge-group": (state, options) =>
    admitDevDeliveryMergeGroup(state, identity(options), {
      mergeGroupHead: options.mergeGroupHead,
      providerRunId: options.providerRunId,
      providerRunAttempt: options.providerRunAttempt,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl:
        options.apiUrl ||
        process.env.GITHUB_API_URL ||
        "https://api.github.com",
      now: options.now,
    }),
  settle: settleDevDeliveryAuthorityWithProvider,
};

function readCommandDocuments(options) {
  for (const [field, file] of [
    ["sourceProof", options.sourceProofPath],
    ["nativeProof", options.nativeProofPath],
    ["qualificationContract", options.qualificationContractPath],
    ["providerAttempt", options.providerAttemptPath],
  ]) {
    if (file)
      options[field] = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  }
}

export async function runDevDeliveryAuthorityCommandAdapter(loaded, options) {
  const loadedV2 =
    loaded.exists &&
    loaded.queue?.contract === "kungfu-buildchain-dev-delivery-authority" &&
    Number(loaded.queue?.schemaVersion) === 2;
  if (options.command === "migrate" && loadedV2) {
    throw new Error("migration target state ref already exists");
  }
  if (options.command !== "migrate" && !loadedV2) {
    throw new Error(
      "v2 authority state is missing; explicitly migrate the exact current v1 state before mutation",
    );
  }
  if (
    options.expectedOldStateRoot &&
    loaded.queue.stateRoot !== options.expectedOldStateRoot
  ) {
    throw new Error(
      `expected-old state drift: ${loaded.queue.stateRoot} != ${options.expectedOldStateRoot}`,
    );
  }
  if (options.command === "observe") {
    return {
      result: {
        schema: "kungfu.buildchain.dev-delivery-authority-command-result/v1",
        ok: true,
        mode: "observe",
        stateRef: options.stateRef,
        stateCommit: loaded.commitSha,
        observation: observeDevDeliveryAuthorityState(loaded.queue, {
          now: options.now,
        }),
      },
    };
  }
  readCommandDocuments(options);
  if (options.command === "heartbeat-landing" && !options.providerAttempt) {
    throw new Error(
      "heartbeat-landing requires --provider-attempt with the exact persisted admitted attempt",
    );
  }
  const adapter = commandAdapters[options.command];
  if (!adapter) {
    throw new Error(
      `unsupported dev authority command ${options.command || "<empty>"}`,
    );
  }
  return { changed: await adapter(loaded.queue, options) };
}
