import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { transactionJournal } from "../../observability/transaction-journal.js";
import { planControllerEvidence } from "../../observability/controller-evidence-io.js";
import { verifyReleasePropagationWork } from "../release-propagation.js";
import {
  propagationPaths,
  readPropagation,
  writePropagation,
} from "./store.js";
import {
  controllerIdentities,
  writePropagationInputs,
  planPropagation,
  resolvePropagationBranch,
  capturePropagationWork,
  writePropagationLock,
} from "./planning.js";
import {
  recordMaterialization,
  refreshPropagationBadges,
  summarizePropagation,
  propagationReceipt,
  recordDelivery,
  exposePropagationWork,
} from "./work.js";
import { preparePropagationOutcome, openPropagationPr } from "./delivery.js";

const stageIds = [
  "resolve-runtime",
  "controller-plan",
  "plan",
  "emit-work",
  "write-lock",
  "downstream-update",
  "prepare",
  "refresh-badges",
  "verify-consumer",
  "record-materialization",
  "summary",
  "pr-outcome",
  "open-pr",
  "receipt",
  "record-delivery",
  "work-output",
];
export function propagationJournal(context) {
  return transactionJournal(
    path.join(propagationPaths(context).root, "execution.json"),
    stageIds,
  );
}
export async function resolvePropagation(context, emit = () => {}) {
  const { runtime, workspace } = propagationPaths(context);
  const journal = propagationJournal(context);
  const identity = await journal.observe("resolve-runtime", () =>
    controllerIdentities(context),
  );
  const controller = await journal.observe("controller-plan", () =>
    planControllerEvidence({
      registryPath: path.join(runtime, "dist/site/controller-registry.json"),
      outputPath: path.join(workspace, ".buildchain/controller/plan.json"),
      controllerId: "release-propagation",
      source: context.source,
      runtime: {
        ref: context.runtimeRef,
        sha: identity["runtime-sha"],
        contractDigest: identity["contract-digest"],
      },
      inputs: context.request,
      inputBoundary: "workflow-call",
    }),
  );
  emit({
    "controller-plan-json": JSON.stringify(controller),
    "controller-plan-digest": controller.digest,
  });
  return journal.observe("plan", () => {
    writePropagationInputs(context);
    const target = planPropagation(context);
    writePropagation("target.json", target, context);
    return target;
  });
}
export async function capturePropagation(context, ports = {}) {
  const journal = propagationJournal(context);
  return journal.observe("emit-work", async () => {
    const branch = await (ports.branch || resolvePropagationBranch)(context);
    writePropagation("branch.json", branch, context);
    return (ports.capture || capturePropagationWork)(context);
  });
}

export async function materializePropagation(context, ports = {}) {
  // Work authority is read back here; a caller's boolean is not execution authority.
  const work = verifyReleasePropagationWork(
    readPropagation("work.json", context),
  );
  if (work.work.authority.mode !== "execute") return { execute: false };
  const journal = propagationJournal(context),
    input = context.request;
  const target = readPropagation("target.json", context);
  const lock = await journal.observe("write-lock", () =>
    (ports.lock || writePropagationLock)(context),
  );
  const consumer = consumerCommandSession();
  const consume =
    ports.consume ||
    ((context, script, extra) =>
      consumer.run({
        script,
        cwd: propagationPaths(context).downstream,
        env: { ...extra, BUILDCHAIN_NODE_PATH: context.nodePath },
        strict: true,
      }));
  const update = input["downstream-update-command"] || target.update_command;
  if (update)
    await journal.observe("downstream-update", () =>
      consume(context, update, {
        BUILDCHAIN_PROPAGATION_LOCK_PATH:
          input["lock-path"] || target.lock_path,
        BUILDCHAIN_PROPAGATION_LOCK_SHA256: lock.lock_sha,
        BUILDCHAIN_PROPAGATION_KEY: target.propagation_key,
        BUILDCHAIN_PROPAGATION_BRANCH: target.branch,
        BUILDCHAIN_PROPAGATION_UPSTREAM_RELEASE_JSON:
          input["upstream-release-json"],
      }),
    );
  const packageContext = {
    BUILDCHAIN_UPSTREAM_PACKAGE_NAME: target.package_name,
    BUILDCHAIN_UPSTREAM_PACKAGE_VERSION: target.package_version,
    BUILDCHAIN_UPSTREAM_RELEASE_LOCK: target.lock_path,
  };
  const prepare = input["downstream-prepare-command"] || target.prepare_command;
  if (prepare)
    await journal.observe("prepare", () =>
      consume(context, prepare, packageContext),
    );
  if (input["refresh-managed-readme-badges"] === true)
    await journal.observe("refresh-badges", () =>
      (ports.badges || refreshPropagationBadges)(context),
    );
  const verify = input["downstream-verify-command"] || target.verify_command;
  if (verify)
    await journal.observe("verify-consumer", () =>
      consume(context, verify, packageContext),
    );
  await journal.observe("record-materialization", () =>
    (ports.record || recordMaterialization)(context),
  );
  await journal.observe("summary", () =>
    (ports.summary || summarizePropagation)(context),
  );
  return { execute: true, lock };
}

export async function reconcilePropagation(
  context,
  predecessorsOk,
  emit = () => {},
  ports = {},
) {
  const journal = propagationJournal(context);
  // Exposing captured Work is an always obligation, including a failed predecessor.
  const captured = journal.stages["emit-work"]?.status === "success";
  let primaryFailure;
  try {
    if (!predecessorsOk)
      throw new Error("Release propagation predecessors did not succeed");
    const work = verifyReleasePropagationWork(
      readPropagation("work.json", context),
    );
    if (work.work.authority.mode !== "execute") return;
    await journal.observe("pr-outcome", () =>
      (ports.outcome || preparePropagationOutcome)(context),
    );
    if (context.request["dry-run"] === false)
      await journal.observe("open-pr", () =>
        (ports.open || openPropagationPr)(context),
      );
    const receipt = await journal.observe("receipt", () =>
      (ports.receipt || propagationReceipt)(context),
    );
    emit(receipt);
    if (context.request["dry-run"] === false)
      await journal.observe("record-delivery", () =>
        (ports.record || recordDelivery)(context),
      );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (captured) {
      try {
        emit(
          await journal.observe("work-output", () =>
            (ports.expose || exposePropagationWork)(context),
          ),
        );
      } catch (error) {
        if (!primaryFailure) throw error;
        const failure = new AggregateError(
          [primaryFailure, error],
          `${primaryFailure.message}; Work output: ${error.message}`,
          { cause: primaryFailure },
        );
        failure.status = primaryFailure.status;
        throw failure;
      }
    }
  }
}
