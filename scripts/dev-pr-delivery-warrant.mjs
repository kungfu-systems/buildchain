import fs from "node:fs";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ADMISSION_SCHEMA = "kungfu.buildchain.dev-pr-admission/v1";

function mismatch(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function createDevPrAdmissionReceipt({ options, pr = {}, state, reason, readiness, decision = {}, queue = null, warrant = null, labels = [], nextAction }) {
  const observedHeadSha = String(pr.head?.sha || "").toLowerCase();
  return {
    schema: ADMISSION_SCHEMA,
    repository: options.repository.fullName,
    targetBranch: options.targetBranch,
    pullRequestNumber: options.targetPullRequestNumber,
    pullRequestUrl: pr.html_url || `https://github.com/${options.repository.fullName}/pull/${options.targetPullRequestNumber}`,
    expectedHeadSha: options.expectedHeadSha,
    observedHeadSha,
    observedBaseBranch: pr.base?.ref || "",
    headRepository: pr.head?.repo?.full_name || "",
    headRef: pr.head?.ref || "",
    observedLabels: [...labels].sort(),
    policy: {
      readyLabel: options.readyLabel,
      blockLabels: options.blockLabels,
      allowedHeadPrefixes: options.allowedHeadPrefixes,
      requiredChecks: options.requiredChecks,
      requireApproval: options.requireApproval,
      sameRepositoryOnly: options.sameRepositoryOnly,
      landingMode: options.landingMode,
      queueAdmissionContext: options.queueAdmissionContext,
      diagnosticContext: options.diagnosticContext,
    },
    readiness: {
      label: options.readyLabel,
      observed: readiness?.observed === true,
      established: readiness?.established === true,
      mutationAuthorized: !options.dryRun,
    },
    approval: decision.approval || { required: options.requireApproval, passed: false },
    checks: decision.checks || { required: options.requiredChecks, entries: [], passed: false },
    queue,
    deliveryWarrant: warrant,
    autoMergeEnabled: Boolean(pr.auto_merge || pr.autoMergeRequest),
    state,
    reason,
    decision: state,
    qualification: ["ready", "queued"].includes(state),
    nextAction: nextAction({ options, state, reason, observedHeadSha }),
  };
}

export function readDeliveryWarrantResult(options, pullRequest) {
  if (options.warrantMode === "off") return null;
  if (!options.warrantResultPath) mismatch("missing-delivery-warrant");
  let result;
  try {
    result = JSON.parse(fs.readFileSync(options.warrantResultPath, "utf8"));
  } catch (cause) {
    const error = new Error(`delivery Warrant result is unreadable: ${cause.message}`);
    error.code = "invalid-delivery-warrant-result";
    throw error;
  }
  const warrant = result.warrant || result.observation?.activeWarrant;
  if (result.schema !== "kungfu.buildchain.dev-delivery-command-result/v1") mismatch("unsupported-delivery-warrant-result");
  if (result.mode !== "execute") mismatch("delivery-warrant-not-executed");
  if (!warrant || warrant.schema !== "kungfu.buildchain.dev-delivery-warrant/v1") mismatch("delivery-warrant-missing");
  if (warrant.repository !== options.repository.fullName) mismatch("delivery-warrant-repository-mismatch");
  if (warrant.protectedBase !== options.targetBranch) mismatch("delivery-warrant-base-mismatch");
  if (Number(warrant.pullRequestNumber) !== Number(pullRequest.number)) mismatch("delivery-warrant-pr-mismatch");
  if (String(warrant.sourceHead || "").toLowerCase() !== options.expectedHeadSha) mismatch("delivery-warrant-head-mismatch");
  if (!ROOT_PATTERN.test(String(warrant.fencingToken || ""))) mismatch("delivery-warrant-fencing-missing");
  if (!Number.isInteger(Number(warrant.generation)) || Number(warrant.generation) < 1) mismatch("delivery-warrant-generation-invalid");
  if (!Number.isFinite(Date.parse(warrant.expiresAt)) || Date.parse(warrant.expiresAt) <= Date.now()) mismatch("delivery-warrant-expired");
  if (!ROOT_PATTERN.test(String(result.receiptRoot || ""))) mismatch("delivery-warrant-receipt-root-missing");
  if (!ROOT_PATTERN.test(String(result.after?.stateRoot || ""))) mismatch("delivery-warrant-state-readback-missing");
  return {
    stateRef: result.stateRef || "",
    stateRoot: result.after.stateRoot,
    receiptRoot: result.receiptRoot,
    candidateId: warrant.candidateId,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    issuedAt: warrant.issuedAt,
    expiresAt: warrant.expiresAt,
  };
}

export async function runSourceQualification({ options, pullRequest, readiness, client, evaluate, admissionState, createReceipt, root, publishDiagnostic, reject }) {
  const decision = await evaluate(pullRequest, { ...options, landingMode: options.landingMode, dryRun: true }, client);
  if (decision.observedHeadSha && String(decision.observedHeadSha).toLowerCase() !== options.expectedHeadSha) {
    return reject("stale", "head-sha-drift-during-source-qualification", readiness);
  }
  const state = decision.action === "would-merge" ? "ready" : admissionState(decision);
  const receipt = createReceipt({
    options,
    pr: pullRequest,
    state,
    reason: state === "ready" ? "source-qualified-exact-head" : decision.reason,
    readiness,
    decision,
    queue: null,
    warrant: null,
  });
  const result = {
    schema: "kungfu.buildchain.dev-pr-admission-result/v1",
    ok: state === "ready",
    mode: options.dryRun ? "plan" : "execute",
    outcome: state === "ready" ? "source-qualified" : "targeted-admission-failed",
    receipt,
    receiptRoot: root(receipt),
    diagnostic: null,
  };
  if (!options.dryRun) result.diagnostic = await publishDiagnostic(client, options, receipt, result.receiptRoot);
  return result;
}

export async function admitExistingQueueEntry({ options, pullRequest, readiness, client, entry, warrant, createReceipt, root, publishDiagnostic }) {
  if (!entry) return null;
  const receipt = createReceipt({
    options,
    pr: pullRequest,
    state: "queued",
    reason: "already-enqueued-exact-head",
    readiness,
    queue: { enabled: true, entry },
    warrant,
  });
  const result = {
    schema: "kungfu.buildchain.dev-pr-admission-result/v1",
    ok: true,
    mode: options.dryRun ? "plan" : "execute",
    outcome: "admitted",
    receipt,
    receiptRoot: root(receipt),
    diagnostic: null,
  };
  if (!options.dryRun) result.diagnostic = await publishDiagnostic(client, options, receipt, result.receiptRoot);
  return result;
}

export async function runTargetedQueueAdmission({ options, pullRequest, readiness, client, warrant, runController, admissionState, createReceipt, root, publishDiagnostic }) {
  const targetedClient = Object.create(client);
  targetedClient.listPullRequests = async () => [pullRequest];
  const controller = await runController({ ...options, targetPullRequestNumber: 0 }, targetedClient);
  controller.runKind = "targeted-admission-evaluation";
  controller.outcome = controller.actions.length === 0 ? "target-not-admitted" : "target-action-selected";
  controller.qualification = false;
  controller.noOp = controller.actions.length === 0;
  const entry = controller.evaluated.find((value) => value.number === pullRequest.number) || { action: "skip", reason: "target-not-selected" };
  const state = admissionState(entry);
  const receipt = createReceipt({
    options,
    pr: pullRequest,
    state,
    reason: entry.reason,
    readiness,
    decision: entry,
    queue: {
      enabled: controller.mergeQueue?.enabled === true,
      predecessor: entry.admissionReceipt?.predecessor || null,
      entry: entry.queueEntry || null,
    },
    warrant,
  });
  const admitted = ["ready", "queued"].includes(state);
  const result = {
    schema: "kungfu.buildchain.dev-pr-admission-result/v1",
    ok: admitted,
    mode: options.dryRun ? "plan" : "execute",
    outcome: admitted ? "admitted" : "targeted-admission-failed",
    receipt,
    receiptRoot: root(receipt),
    diagnostic: null,
    controller,
  };
  if (!options.dryRun) result.diagnostic = await publishDiagnostic(client, options, receipt, result.receiptRoot);
  return result;
}
