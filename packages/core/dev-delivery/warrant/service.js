import { GitHubDevDeliveryStore } from "../../providers/dev-delivery/store.js";
import { persistDevDeliveryTransition } from "./persistence.js";
import { observeDevDeliveryQueue } from "../dev-delivery-warrant.js";
import {
  normalizeRepository,
  normalizeBranch,
  normalizeStateRef,
  bool,
  exactRoot,
} from "./values.js";
import { transitionFor } from "./transitions.js";
import { observeQueue } from "./observation.js";
function requireTerminalEvidenceCas(options) {
  if (
    options.command === "reconcile-terminal-evidence" &&
    options.execute &&
    !options.expectedOldStateRoot
  ) {
    throw new Error(
      "terminal evidence reconciliation execute requires expected-old CAS",
    );
  }
  if (
    options.command === "fence-writer-protocol" &&
    options.execute &&
    !options.expectedOldStateRoot
  ) {
    throw new Error("writer protocol fence execute requires expected-old CAS");
  }
}

export async function runDevDeliveryCommand(optionsInput = {}, clientInput) {
  const options = {
    ...optionsInput,
    repository: normalizeRepository(optionsInput.repository).fullName,
    branch: normalizeBranch(optionsInput.branch),
    stateRef: normalizeStateRef(optionsInput.stateRef, optionsInput.branch),
    now: new Date(optionsInput.now || Date.now()).toISOString(),
    execute: bool(optionsInput.execute, false),
  };
  requireTerminalEvidenceCas(options);
  if (
    options.command === "submit" &&
    options.execute &&
    options.deliveryClass !== "non-native-fast"
  ) {
    exactRoot(options.environmentRoot, "environmentRoot");
  }
  const store =
    clientInput ||
    new GitHubDevDeliveryStore({
      repository: options.repository,
      token: options.token,
      apiUrl: options.apiUrl || "https://api.github.com",
    });
  let loaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
  });
  let concurrencyRecovery = null;
  if (
    options.expectedOldStateRoot &&
    loaded.queue.stateRoot !== options.expectedOldStateRoot
  ) {
    if (options.command !== "heartbeat") {
      throw new Error(
        `expected-old state drift: ${loaded.queue.stateRoot} != ${options.expectedOldStateRoot}`,
      );
    }
    concurrencyRecovery = {
      schema: "kungfu.buildchain.dev-delivery-concurrency-recovery/v1",
      action: "heartbeat-state-root-rebased",
      requestedStateRoot: options.expectedOldStateRoot,
      observedStateRoot: loaded.queue.stateRoot,
      observedCommitSha: loaded.commitSha,
    };
  }
  if (options.command === "observe") return observeQueue(loaded, options);
  const initialLoaded = loaded;
  const persisted = await persistDevDeliveryTransition({
    store,
    options,
    loaded,
    initialLoaded,
    changed: transitionFor(options.command, loaded.queue, options),
    transitionFor,
  });
  loaded = persisted.loaded;
  concurrencyRecovery = persisted.concurrencyRecovery || concurrencyRecovery;
  return {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    ok: true,
    mode: options.execute ? "execute" : "plan",
    command: options.command,
    stateRef: options.stateRef,
    before: { commitSha: loaded.commitSha, stateRoot: loaded.queue.stateRoot },
    after: {
      commitSha: persisted.write?.commitSha || loaded.commitSha,
      stateRoot: persisted.changed.queue.stateRoot,
    },
    mutationAuthorized: options.execute,
    mutationApplied: Boolean(persisted.write),
    concurrencyRecovery,
    receipt: persisted.changed.receipt,
    receiptRoot: persisted.changed.receiptRoot,
    warrant:
      persisted.changed.warrant ||
      persisted.changed.queue.activeWarrant ||
      null,
    observation: observeDevDeliveryQueue(persisted.changed.queue, {
      now: options.now,
    }),
  };
}

// Named operations share the same rooted transition, CAS and readback engine.
export function createDeliveryWarrantService(connection, store) {
  const execute = (command, request = {}) =>
    runDevDeliveryCommand({ ...connection, ...request, command }, store);
  return {
    observe: (request) => execute("observe", request),
    submit: (request) => execute("submit", request),
    select: (request) => execute("select", request),
    heartbeat: (request) => execute("heartbeat", request),
    qualify: (request) => execute("qualify", request),
    recover: (request) => execute("recover", request),
    close: (request) => execute("close", request),
    settle: (request) => execute("settle", request),
    reconcile: (request) => execute("reconcile-terminal-evidence", request),
    cancelQueued: (request) => execute("cancel-queued", request),
    fenceWriter: (request) => execute("fence-writer-protocol", request),
  };
}
