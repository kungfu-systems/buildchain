import {
  RELEASE_PROPAGATION_PLAN_CONTRACT,
  assertPlainObject,
  assertString,
  normalizeChannel,
  sha256Json,
} from "./release-propagation-common.js";
import { normalizeExecutionProfile } from "./release-propagation-execution-profile.js";
import {
  normalizeUpstreamRelease,
  verifyReleaseLockBinding,
} from "./release-propagation-release.js";
import { resolveWorkContext } from "./release-propagation-work-capture.js";
import { normalizeStageReceipt } from "./release-propagation-stage-evidence.js";
export { normalizeStageReceipt } from "./release-propagation-stage-evidence.js";
import {
  assertCommitSha,
  assertContentRoot,
  assertExactFields,
  contentRoot,
  normalizeFamilyStateReference,
  normalizeTypedReference,
  normalizeWorkAuthority,
  normalizeWorkRef,
} from "./release-propagation-work-control.js";
export {
  RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
  RELEASE_PROPAGATION_WORK_CONTRACT,
  RELEASE_PROPAGATION_WORK_STAGES,
} from "./release-propagation-work-constants.js";
import {
  RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
  RELEASE_PROPAGATION_WORK_CONTRACT,
  RELEASE_PROPAGATION_WORK_STAGES,
} from "./release-propagation-work-constants.js";

function selectPropagationTarget(plan, target) {
  const selectedPlan = assertPlainObject(plan, "plan");
  if (selectedPlan.contract !== RELEASE_PROPAGATION_PLAN_CONTRACT || selectedPlan.schemaVersion !== 1) {
    throw new Error("plan must be a Buildchain release propagation plan v1");
  }
  if (!Array.isArray(selectedPlan.targets)) {
    throw new Error("plan.targets must be an array");
  }
  const matches = selectedPlan.targets.filter((entry) =>
    !target || entry.target === target || entry.repository === target);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one propagation target, found ${matches.length}`);
  }
  const selected = matches[0];
  const expectedLockSha = sha256Json({ ...selected.lock, lockSha256: undefined });
  if (selected.lock?.lockSha256 !== expectedLockSha) {
    throw new Error("propagation target release lock root does not verify");
  }
  const propagationKey = selected.propagationKey || selected.lock.propagation?.propagationKey || "";
  if (!/^[0-9a-f]{64}$/.test(propagationKey)) {
    throw new Error("propagation target key is not an exact SHA-256 digest");
  }
  if (selected.lock.propagation.propagationKey !== propagationKey) {
    throw new Error("propagation target key disagrees with the exact release lock");
  }
  return { selectedPlan, selected, propagationKey };
}

function workCommands(executionProfile = null, repository = "", branch = "", baseRef = "") {
  const profile = executionProfile || {};
  const workflow = profile.workflow || "buildchain-web-surface.yml";
  const releaseLabel = profile.productionReleaseLabel || "buildchain-release";
  return {
    plan: "buildchain release-propagation work status --work <work.json> --json",
    status: "buildchain release-propagation work status --work <work.json> --json",
    nextAction: "buildchain release-propagation work resume --work <work.json> --json",
    resume: "buildchain release-propagation work resume --work <work.json> --json",
    repair: "buildchain release-propagation work repair --work <work.json> --expected-work-root <sha256:...> --receipt <receipt.json> --output <successor.json> --json",
    record: "buildchain release-propagation work record --work <work.json> --expected-work-root <sha256:...> --receipt <receipt.json> --output <successor.json> --json",
    complete: "buildchain release-propagation work complete --work <work.json> --expected-work-root <sha256:...> --receipt <receipt.json> --completion-decision <reference.json> --output <successor.json> --json",
    stages: {
      materialize: profile.updateCommand || "<consumer update command from the exact execution profile>",
      "verify-release": profile.verifyCommand || "<consumer verification command from the exact execution profile>",
      "push-branch": `git push --force-with-lease=<exact-expected-old> origin HEAD:refs/heads/${branch || "<managed-branch>"}`,
      "pull-request": `gh pr create --repo ${repository || "<downstream-repository>"} --base ${baseRef || "<base-ref>"} --head ${branch || "<managed-branch>"}`,
      preview: `gh run list --repo ${repository || "<downstream-repository>"} --workflow ${workflow} --branch ${branch || "<managed-branch>"} --event pull_request --json databaseId,status,conclusion,url,headSha`,
      "independent-review": `gh pr review <pr-number> --repo ${repository || "<downstream-repository>"} --approve`,
      "protected-merge": `gh pr merge <pr-number> --repo ${repository || "<downstream-repository>"} --squash --delete-branch=false`,
      staging: `gh run list --repo ${repository || "<downstream-repository>"} --workflow ${workflow} --branch ${baseRef || "<base-ref>"} --event push --json databaseId,status,conclusion,url,headSha`,
      "production-release": `gh pr list --repo ${repository || "<downstream-repository>"} --state open --label ${releaseLabel} --json number,url,headRefName,baseRefName,headRefOid`,
      "production-deploy": `gh run list --repo ${repository || "<downstream-repository>"} --workflow ${workflow} --event pull_request --json databaseId,status,conclusion,url,headSha`,
      "online-readback": [profile.productionStatusUrl, ...(profile.readbackUrls || [])].filter(Boolean).map((url) => `curl --fail --location --silent --show-error ${url}`).join(" && "),
      complete: "buildchain release-propagation work complete <exact receipt and accepted Work Control Decision>",
    },
  };
}

export function nextWorkAction(work, action, stage, reason = "") {
  const command = action === "claim"
    ? "buildchain release-propagation work claim --work <work.json> --family-state <family-state.json> --authority <authority.json> --expected-work-root <sha256:...> --output <successor.json> --json"
    : action === "none"
      ? ""
      : action === "repair"
        ? work.plan.commands.repair
        : work.plan.commands.record;
  return { action, stage, command, reason };
}

export function withWorkRoot(body) {
  const value = structuredClone(body);
  delete value.contentRoot;
  return { ...value, contentRoot: contentRoot(value) };
}

export function createReleasePropagationWork({
  plan,
  target = "",
  workContext,
  expectedDownstreamBaseSha,
} = {}) {
  const { selectedPlan, selected, propagationKey } = selectPropagationTarget(plan, target);
  const context = resolveWorkContext(workContext, selectedPlan, selected, propagationKey);
  const parentWorkRef = normalizeWorkRef(context.parentWorkRef, "workContext.parentWorkRef");
  const childWorkRef = normalizeWorkRef(context.childWorkRef, "workContext.childWorkRef");
  if (childWorkRef.object_kind !== "assignment") {
    throw new Error("workContext.childWorkRef must identify an Assignment");
  }
  if (parentWorkRef.subject === childWorkRef.subject
      && parentWorkRef.workspace_identity_root === childWorkRef.workspace_identity_root) {
    throw new Error("parent and child WorkRefs must identify different work");
  }
  const familyState = context.bindingState === "bound"
    ? normalizeFamilyStateReference(context.familyState)
    : null;
  const authority = normalizeWorkAuthority(context.authority, familyState);
  const supersedesWorkRoot = assertContentRoot(
    context.supersedesWorkRoot,
    "workContext.supersedesWorkRoot",
    { optional: true },
  );
  const identity = {
    propagationKey,
    parentWorkRef,
    childWorkRef,
  };
  const identityRoot = contentRoot(identity);
  const workId = `propagation-${propagationKey.slice(0, 16)}-${identityRoot.slice(-12)}`;
  if (!selected.executionProfile) {
    throw new Error("agent-native propagation work requires a downstream execution profile");
  }
  const commands = workCommands(
    selected.executionProfile,
    selected.repository,
    selected.branch,
    selected.baseRef,
  );
  const initial = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_WORK_CONTRACT,
    workId,
    revision: 0,
    previousWorkRoot: "",
    propagationKey,
    upstream: {
      releaseRoot: contentRoot(selectedPlan.upstreamRelease),
      release: structuredClone(selectedPlan.upstreamRelease),
    },
    downstream: {
      target: selected.target,
      repository: selected.repository,
      channel: selected.channel,
      baseRef: selected.baseRef,
      expectedBaseSha: assertCommitSha(expectedDownstreamBaseSha, "expectedDownstreamBaseSha"),
      branch: selected.branch,
      lockPath: selected.lockPath,
      lockSha256: selected.lock.lockSha256,
      releaseLock: structuredClone(selected.lock),
      executionProfile: structuredClone(selected.executionProfile),
    },
    workControl: {
      bindingState: context.bindingState,
      parentWorkRef,
      childWorkRef,
      familyState,
    },
    intent: { publishToProduction: authority.publishToProduction },
    authority,
    deduplication: {
      identityRoot,
      propagationKey,
      supersedesWorkRoot,
      policy: "exact-identity-reuse-newer-release-explicit-supersession",
    },
    plan: {
      stages: [...RELEASE_PROPAGATION_WORK_STAGES],
      commands,
    },
    state: {
      lifecycle: authority.mode === "execute" ? "ready" : "paused",
      currentStage: RELEASE_PROPAGATION_WORK_STAGES[0],
      nextAction: null,
      recoveryCursor: {
        stage: RELEASE_PROPAGATION_WORK_STAGES[0],
        index: 0,
        attempt: 1,
        lastReceiptRoot: "",
      },
    },
    stageReceipts: [],
    completionDecision: null,
  };
  initial.state.nextAction = authority.mode === "execute"
    ? nextWorkAction(initial, "record", initial.state.currentStage)
    : nextWorkAction(initial, "claim", initial.state.currentStage, "execution-authority-required");
  return verifyReleasePropagationWork(withWorkRoot(initial)).work;
}

export function createReleasePropagationStageReceipt({
  work,
  stage,
  outcome = "success",
  observedAt,
  actor,
  summary,
  evidence,
  failure = null,
} = {}) {
  const verification = verifyReleasePropagationWork(work);
  const body = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
    workId: verification.work.workId,
    expectedWorkRoot: verification.work.contentRoot,
    stage: stage || verification.currentStage,
    outcome,
    attempt: verification.work.state.recoveryCursor.attempt,
    observedAt,
    actor,
    summary,
    evidence,
    failure,
  };
  const receipt = { ...body, receiptRoot: contentRoot(body) };
  return normalizeStageReceipt(receipt, {
    work: verification.work,
    workId: verification.work.workId,
    expectedWorkRoot: verification.work.contentRoot,
    expectedStage: verification.currentStage,
    allowedOutcomes: new Set(["success", "failure", "repair"]),
  });
}

export function assertExpectedWorkRoot(work, expectedWorkRoot) {
  const expected = assertContentRoot(expectedWorkRoot, "expectedWorkRoot");
  if (work.contentRoot !== expected) {
    throw new Error("propagation work changed before transition");
  }
}

export function successorWork(work) {
  const successor = structuredClone(work);
  successor.revision += 1;
  successor.previousWorkRoot = work.contentRoot;
  delete successor.contentRoot;
  return successor;
}

function verifyWorkHeader(work) {
  if (work.schemaVersion !== 1 || work.contract !== RELEASE_PROPAGATION_WORK_CONTRACT) {
    throw new Error("release propagation work must use the v1 contract");
  }
  if (!Number.isInteger(work.revision) || work.revision < 0) {
    throw new Error("release propagation work revision must be a non-negative integer");
  }
  assertContentRoot(work.previousWorkRoot, "release propagation work previousWorkRoot", {
    optional: work.revision === 0,
  });
  if (work.revision === 0 && work.previousWorkRoot !== "") {
    throw new Error("initial propagation work cannot name a previous root");
  }
  if (!/^[0-9a-f]{64}$/.test(work.propagationKey)) {
    throw new Error("release propagation work key must be an exact SHA-256 digest");
  }
}

function verifyWorkRelease(work) {
  const upstream = assertExactFields(
    work.upstream,
    ["releaseRoot", "release"],
    "release propagation work upstream",
  );
  const normalizedRelease = normalizeUpstreamRelease(upstream.release);
  if (upstream.releaseRoot !== contentRoot(normalizedRelease)) {
    throw new Error("release propagation work upstream root does not verify");
  }
  const downstream = assertExactFields(work.downstream, [
    "target", "repository", "channel", "baseRef", "expectedBaseSha", "branch",
    "lockPath", "lockSha256", "releaseLock", "executionProfile",
  ], "release propagation work downstream");
  assertString(downstream.target, "release propagation work downstream.target");
  assertString(downstream.repository, "release propagation work downstream.repository");
  normalizeChannel(downstream.channel, "release propagation work downstream.channel");
  assertString(downstream.baseRef, "release propagation work downstream.baseRef");
  assertCommitSha(downstream.expectedBaseSha, "release propagation work downstream.expectedBaseSha");
  assertString(downstream.branch, "release propagation work downstream.branch");
  assertString(downstream.lockPath, "release propagation work downstream.lockPath");
  if (downstream.lockSha256 !== sha256Json({ ...downstream.releaseLock, lockSha256: undefined })) {
    throw new Error("release propagation work downstream lock root does not verify");
  }
  if (downstream.releaseLock.lockSha256 !== downstream.lockSha256
      || downstream.releaseLock.propagation.propagationKey !== work.propagationKey) {
    throw new Error("release propagation work downstream lock identity disagrees with the work");
  }
  verifyReleaseLockBinding({
    release: normalizedRelease,
    lock: downstream.releaseLock,
    downstream,
    propagationKey: work.propagationKey,
  });
  const profile = normalizeExecutionProfile(
    downstream.executionProfile,
    "release propagation work downstream.executionProfile",
  );
  const lockedProfile = normalizeExecutionProfile(
    downstream.releaseLock.downstream.executionProfile,
    "release propagation work releaseLock.downstream.executionProfile",
  );
  if (!profile || !lockedProfile
      || sha256Json(profile) !== sha256Json(lockedProfile)) {
    throw new Error("release propagation work execution profile disagrees with the exact release lock");
  }
  return { downstream, profile };
}

function verifyWorkControl(work) {
  const workControl = assertExactFields(
    work.workControl,
    ["bindingState", "parentWorkRef", "childWorkRef", "familyState"],
    "release propagation work Work Control",
  );
  const parentWorkRef = normalizeWorkRef(
    workControl.parentWorkRef,
    "release propagation work parentWorkRef",
  );
  const childWorkRef = normalizeWorkRef(
    workControl.childWorkRef,
    "release propagation work childWorkRef",
  );
  if (!new Set(["pending", "bound"]).has(workControl.bindingState)) {
    throw new Error("release propagation work binding state is unsupported");
  }
  const familyState = workControl.bindingState === "bound"
    ? normalizeFamilyStateReference(workControl.familyState)
    : null;
  if (workControl.bindingState === "pending" && workControl.familyState !== null) {
    throw new Error("pending propagation work cannot claim a Family State");
  }
  const authority = normalizeWorkAuthority(work.authority, familyState);
  if (workControl.bindingState === "pending" && authority.mode !== "capture-only") {
    throw new Error("pending propagation work must remain capture-only");
  }
  const intent = assertExactFields(
    work.intent,
    ["publishToProduction"],
    "release propagation work intent",
  );
  if (intent.publishToProduction !== authority.publishToProduction) {
    throw new Error("release propagation work intent disagrees with its authority");
  }
  const identityRoot = contentRoot({
    propagationKey: work.propagationKey,
    parentWorkRef,
    childWorkRef,
  });
  const deduplication = assertExactFields(work.deduplication, [
    "identityRoot", "propagationKey", "supersedesWorkRoot", "policy",
  ], "release propagation work deduplication");
  if (deduplication.identityRoot !== identityRoot
      || deduplication.propagationKey !== work.propagationKey) {
    throw new Error("release propagation work deterministic identity does not verify");
  }
  assertContentRoot(
    deduplication.supersedesWorkRoot,
    "release propagation work supersedesWorkRoot",
    { optional: true },
  );
  if (deduplication.policy !== "exact-identity-reuse-newer-release-explicit-supersession") {
    throw new Error("release propagation work supersession policy is unsupported");
  }
  if (work.workId !== `propagation-${work.propagationKey.slice(0, 16)}-${identityRoot.slice(-12)}`) {
    throw new Error("release propagation work id is not deterministic");
  }
  return familyState;
}

function verifyWorkPlanAndState(work, downstream, profile) {
  const plan = assertExactFields(
    work.plan,
    ["stages", "commands"],
    "release propagation work plan",
  );
  if (JSON.stringify(plan.stages) !== JSON.stringify(RELEASE_PROPAGATION_WORK_STAGES)) {
    throw new Error("release propagation work stage order is not canonical");
  }
  const expectedCommands = workCommands(
    profile,
    downstream.repository,
    downstream.branch,
    downstream.baseRef,
  );
  if (sha256Json(plan.commands) !== sha256Json(expectedCommands)) {
    throw new Error("release propagation work commands are not canonical");
  }
  const state = assertExactFields(
    work.state,
    ["lifecycle", "currentStage", "nextAction", "recoveryCursor"],
    "release propagation work state",
  );
  const cursor = assertExactFields(
    state.recoveryCursor,
    ["stage", "index", "attempt", "lastReceiptRoot"],
    "release propagation work recovery cursor",
  );
  if (cursor.stage !== state.currentStage
      || RELEASE_PROPAGATION_WORK_STAGES[cursor.index] !== state.currentStage) {
    throw new Error("release propagation work recovery cursor is inconsistent");
  }
  if (!Number.isInteger(cursor.attempt) || cursor.attempt < 1) {
    throw new Error("release propagation work recovery attempt must be positive");
  }
  assertContentRoot(
    cursor.lastReceiptRoot,
    "release propagation work lastReceiptRoot",
    { optional: true },
  );
  return { state, cursor };
}

function verifyWorkReceipts(work, state, cursor, familyState) {
  if (!Array.isArray(work.stageReceipts)) {
    throw new Error("release propagation work stageReceipts must be an array");
  }
  for (const receipt of work.stageReceipts) {
    normalizeStageReceipt(receipt, {
      work,
      workId: work.workId,
      expectedWorkRoot: receipt.expectedWorkRoot,
      expectedStage: receipt.stage,
      allowedOutcomes: new Set(["success", "failure", "repair"]),
    });
  }
  const lastReceipt = work.stageReceipts.at(-1);
  if (lastReceipt) {
    if (lastReceipt.expectedWorkRoot !== work.previousWorkRoot) {
      throw new Error("latest stage receipt does not bind the predecessor work root");
    }
    if (cursor.lastReceiptRoot !== lastReceipt.receiptRoot) {
      throw new Error("recovery cursor does not bind the latest stage receipt");
    }
  } else if (cursor.lastReceiptRoot !== "") {
    throw new Error("recovery cursor cannot name a receipt before any transition");
  }
  const successfulStages = work.stageReceipts
    .filter((receipt) => receipt.outcome === "success")
    .map((receipt) => receipt.stage);
  const expectedSuccessful = RELEASE_PROPAGATION_WORK_STAGES.slice(
    0,
    state.lifecycle === "complete" ? -1 : cursor.index,
  );
  if (state.lifecycle === "complete") expectedSuccessful.push("complete");
  if (JSON.stringify(successfulStages) !== JSON.stringify(expectedSuccessful)) {
    throw new Error("release propagation work successful receipts do not match canonical stage order");
  }
  if (state.lifecycle === "complete") {
    if (!familyState) {
      throw new Error("complete propagation work requires a bound Family State");
    }
    normalizeTypedReference(work.completionDecision, {
      kind: "decision",
      status: "accepted",
      factWorld: familyState.factWorld,
      cutRoot: familyState.cutRoot,
      label: "completionDecision",
    });
  } else if (work.completionDecision !== null) {
    throw new Error("unfinished propagation work cannot carry a completion decision");
  }
}

export function verifyReleasePropagationWork(input) {
  const work = assertExactFields(input, [
    "schemaVersion", "contract", "workId", "revision", "previousWorkRoot",
    "propagationKey", "upstream", "downstream", "workControl", "intent",
    "authority", "deduplication", "plan", "state", "stageReceipts",
    "completionDecision", "contentRoot",
  ], "release propagation work");
  verifyWorkHeader(work);
  const { downstream, profile } = verifyWorkRelease(work);
  const familyState = verifyWorkControl(work);
  const { state, cursor } = verifyWorkPlanAndState(work, downstream, profile);
  verifyWorkReceipts(work, state, cursor, familyState);
  const rootBody = structuredClone(work);
  delete rootBody.contentRoot;
  if (work.contentRoot !== contentRoot(rootBody)) {
    throw new Error("release propagation work content root does not verify");
  }
  return {
    ok: true,
    contract: RELEASE_PROPAGATION_WORK_CONTRACT,
    work,
    workId: work.workId,
    contentRoot: work.contentRoot,
    lifecycle: state.lifecycle,
    currentStage: state.currentStage,
    nextAction: state.nextAction,
    recoveryCursor: state.recoveryCursor,
    productionVisible: state.lifecycle === "complete",
    completionQualified: state.lifecycle === "complete" && work.completionDecision !== null,
  };
}

export function resumeReleasePropagationWork(work) {
  const status = verifyReleasePropagationWork(work);
  return { ...status, resumed: true };
}
