import { recoverExpiredDevDeliveryWarrant } from "../packages/core/dev-delivery-warrant.js";

async function recoverExpiredLeaseBeforeReselection({
  store,
  options,
  loaded,
  initialLoaded,
}) {
  const recovery = recoverExpiredDevDeliveryWarrant(loaded.queue, {
    now: options.now,
  });
  if (recovery.receipt.expectedOldStateRoot !== loaded.queue.stateRoot) {
    throw new Error(
      "expired Warrant recovery receipt expected-old root does not match the loaded authority",
    );
  }
  await store.write({
    stateRef: options.stateRef,
    queue: recovery.queue,
    expectedCommitSha: loaded.commitSha,
    expectedStateRoot: loaded.queue.stateRoot,
    receiptRoot: recovery.receiptRoot,
  });
  const reloaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
  });
  return {
    loaded: reloaded,
    concurrencyRecovery: {
      schema: "kungfu.buildchain.dev-delivery-concurrency-recovery/v1",
      action: "expired-lease-recovered-before-reselection",
      initialCommitSha: initialLoaded.commitSha,
      recoveredStateRoot: recovery.queue.stateRoot,
      observedCommitSha: reloaded.commitSha,
      observedStateRoot: reloaded.queue.stateRoot,
    },
  };
}

export async function persistDevDeliveryTransition({
  store,
  options,
  loaded,
  initialLoaded,
  changed,
  transitionFor,
}) {
  let concurrencyRecovery = null;
  if (
    options.execute &&
    options.command === "select" &&
    changed.recoveryReceipt?.action === "recovered-expired-lease"
  ) {
    const recovery = await recoverExpiredLeaseBeforeReselection({
      store,
      options,
      loaded,
      initialLoaded,
    });
    loaded = recovery.loaded;
    changed = transitionFor(options.command, loaded.queue, options);
    concurrencyRecovery = recovery.concurrencyRecovery;
  }
  if (!options.execute || changed.queue.stateRoot === loaded.queue.stateRoot)
    return { loaded, changed, write: null, concurrencyRecovery };
  if (changed.receipt.expectedOldStateRoot !== loaded.queue.stateRoot) {
    throw new Error(
      "transition receipt expected-old root does not match the loaded authority",
    );
  }
  try {
    const write = await store.write({
      stateRef: options.stateRef,
      queue: changed.queue,
      expectedCommitSha: loaded.commitSha,
      expectedStateRoot: loaded.queue.stateRoot,
      receiptRoot: changed.receiptRoot,
    });
    return { loaded, changed, write, concurrencyRecovery };
  } catch (error) {
    if (options.command !== "settle" || options.expectedOldStateRoot)
      throw error;
    const latest = await store.read({
      stateRef: options.stateRef,
      protectedBase: options.branch,
      now: options.now,
    });
    const reconciled = transitionFor(options.command, latest.queue, options);
    if (
      reconciled.queue.stateRoot !== latest.queue.stateRoot ||
      reconciled.receipt.action !== "duplicate-terminal-event-noop"
    )
      throw error;
    return {
      loaded: latest,
      changed: reconciled,
      write: null,
      concurrencyRecovery: {
        schema: "kungfu.buildchain.dev-delivery-concurrency-recovery/v1",
        action: "terminal-settlement-race-noop",
        initialCommitSha: initialLoaded.commitSha,
        observedCommitSha: latest.commitSha,
        observedStateRoot: latest.queue.stateRoot,
      },
    };
  }
}
