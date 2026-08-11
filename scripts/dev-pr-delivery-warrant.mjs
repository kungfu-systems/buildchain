import fs from "node:fs";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ADMISSION_SCHEMA = "kungfu.buildchain.dev-pr-admission/v1";

function mismatch(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requireMatch(condition, code) {
  if (!condition) mismatch(code);
}

function readWarrantResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    const error = new Error(`delivery Warrant result is unreadable: ${cause.message}`);
    error.code = "invalid-delivery-warrant-result";
    throw error;
  }
}

function exactActiveReadback(result) {
  requireMatch(result.schema === "kungfu.buildchain.dev-delivery-command-result/v1", "unsupported-delivery-warrant-result");
  requireMatch(result.mode === "execute", "delivery-warrant-not-executed");
  requireMatch(SHA_PATTERN.test(String(result.after?.commitSha || "")), "delivery-warrant-commit-readback-missing");
  requireMatch(ROOT_PATTERN.test(String(result.after?.stateRoot || "")), "delivery-warrant-state-readback-missing");
  requireMatch(result.observation?.schema === "kungfu.buildchain.dev-delivery-queue-observation/v1", "delivery-warrant-observation-missing");
  requireMatch(result.observation.stateRoot === result.after.stateRoot, "delivery-warrant-observation-root-mismatch");
  const warrant = result.observation.activeWarrant;
  const candidate = result.observation.activeCandidate;
  requireMatch(warrant?.schema === "kungfu.buildchain.dev-delivery-warrant/v1", "delivery-warrant-missing");
  requireMatch((warrant.phase || "qualified") === "qualified", "delivery-warrant-not-qualified");
  if (warrant.phase === "qualified") {
    requireMatch(ROOT_PATTERN.test(String(warrant.nativeProofRoot || "")), "delivery-warrant-native-proof-missing");
    requireMatch(ROOT_PATTERN.test(String(warrant.nativeProofReuseRoot || "")), "delivery-warrant-native-reuse-missing");
  }
  requireMatch(candidate?.candidateId === warrant.candidateId, "delivery-warrant-candidate-readback-missing");
  requireMatch(!result.warrant || JSON.stringify(result.warrant) === JSON.stringify(warrant), "delivery-warrant-readback-mismatch");
  return { warrant, candidate };
}

function exactWarrantBinding({ result, warrant, candidate, options, pullRequest }) {
  requireMatch(warrant.repository === options.repository.fullName, "delivery-warrant-repository-mismatch");
  requireMatch(warrant.protectedBase === options.targetBranch, "delivery-warrant-base-mismatch");
  requireMatch(Number(warrant.pullRequestNumber) === Number(pullRequest.number), "delivery-warrant-pr-mismatch");
  requireMatch(String(warrant.sourceHead || "").toLowerCase() === options.expectedHeadSha, "delivery-warrant-head-mismatch");
  requireMatch(Number(candidate.pullRequestNumber) === Number(pullRequest.number), "delivery-warrant-candidate-pr-mismatch");
  requireMatch(String(candidate.sourceHead || "").toLowerCase() === options.expectedHeadSha, "delivery-warrant-candidate-head-mismatch");
  requireMatch(ROOT_PATTERN.test(String(warrant.fencingToken || "")), "delivery-warrant-fencing-missing");
  requireMatch(Number.isInteger(Number(warrant.generation)) && Number(warrant.generation) >= 1, "delivery-warrant-generation-invalid");
  requireMatch(Number.isFinite(Date.parse(warrant.expiresAt)) && Date.parse(warrant.expiresAt) > Date.now(), "delivery-warrant-expired");
  requireMatch(ROOT_PATTERN.test(String(result.receiptRoot || "")), "delivery-warrant-receipt-root-missing");
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
    projectCut: decision.projectCut || null,
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
  const result = readWarrantResult(options.warrantResultPath);
  const { warrant, candidate } = exactActiveReadback(result);
  exactWarrantBinding({ result, warrant, candidate, options, pullRequest });
  return {
    stateRef: result.stateRef || "",
    stateCommit: result.after.commitSha,
    stateRoot: result.after.stateRoot,
    receiptRoot: result.receiptRoot,
    candidateId: warrant.candidateId,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    issuedAt: warrant.issuedAt,
    expiresAt: warrant.expiresAt,
  };
}

export async function readCurrentDeliveryQueueState(client, repository, targetBranch) {
  if (typeof client.getDevDeliveryQueueState === "function") {
    return client.getDevDeliveryQueueState(targetBranch);
  }
  const stateRef = `buildchain/dev-delivery-warrant/${targetBranch.replaceAll("/", "-")}`;
  const query = new URLSearchParams({ ref: stateRef });
  const { data } = await client.request(
    "GET",
    `/repos/${repository.owner}/${repository.repo}/contents/queue.json?${query}`,
  );
  if (data?.type !== "file" || data?.encoding !== "base64" || !data?.content) {
    mismatch("delivery-warrant-current-readback-invalid");
  }
  return JSON.parse(Buffer.from(String(data.content).replace(/\s+/g, ""), "base64").toString("utf8"));
}

export async function verifyCurrentDeliveryWarrant(client, options, pullRequest, warrant) {
  if (!warrant) return;
  let queue;
  try {
    queue = await readCurrentDeliveryQueueState(client, options.repository, options.targetBranch);
  } catch {
    mismatch("delivery-warrant-current-readback-failed");
  }
  const active = queue?.activeWarrant;
  const candidate = queue?.candidates?.find((entry) => entry.candidateId === active?.candidateId);
  requireMatch(active?.candidateId === warrant.candidateId, "delivery-warrant-no-longer-active");
  requireMatch(active?.fencingToken === warrant.fencingToken, "delivery-warrant-current-fencing-mismatch");
  requireMatch(Number(active?.generation) === Number(warrant.generation), "delivery-warrant-current-generation-mismatch");
  requireMatch(Number(active?.pullRequestNumber) === Number(pullRequest.number), "delivery-warrant-current-pr-mismatch");
  requireMatch(String(active?.sourceHead || "").toLowerCase() === options.expectedHeadSha, "delivery-warrant-current-head-mismatch");
  requireMatch(["selected", "proving", "waiting", "blocked", "qualified"].includes(candidate?.status), "delivery-warrant-current-candidate-not-selected");
  requireMatch(candidate?.sourceHead === active.sourceHead, "delivery-warrant-current-candidate-head-mismatch");
}

export async function enqueueAfterStatusPropagation({ enqueue, input, attempts, delayMs, sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await enqueue(input);
    } catch (error) {
      lastError = error;
      const propagation = /required status(?:es| check).*failing|failing required status|cannot change this locked branch/i.test(String(error?.message || ""));
      if (!propagation || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
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
