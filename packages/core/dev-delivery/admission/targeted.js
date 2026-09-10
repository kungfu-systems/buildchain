import {
  AGENT_ADMISSION_MARKER,
  AGENT_ADMISSION_RESULT_SCHEMA,
  SHA_PATTERN,
  contentRoot,
  normalizeOptions,
} from "./policy.js";
import {
  evaluatePullRequest,
  hasBlockedLabel,
  hasReadyLabel,
  headPrefixAllowed,
  labelsOf,
  sameRepositoryAllowed,
} from "./readiness.js";
import { GitHubClient, delay } from "./github-client.js";
import { GhCliClient } from "./gh-cli-client.js";
import { runDevPrAutoMerge } from "./queue.js";
import {
  admitExistingQueueEntry,
  createDevPrAdmissionReceipt,
  createPreReadinessQueueFence,
  readDeliveryWarrantResult,
  runSourceQualification,
  runTargetedQueueAdmission,
  verifyCurrentDeliveryWarrant,
} from "../commands/dev-pr-delivery-warrant.mjs";
export function admissionStateFor(entry = {}) {
  if (["enqueued", "merged"].includes(entry.action)) return "queued";
  if (["would-enqueue", "would-merge", "merge"].includes(entry.action))
    return "ready";
  if (entry.reason === "missing-approval") return "waiting-approval";
  if (entry.reason === "required-checks-not-passing") return "waiting-checks";
  if (entry.reason === "blocked-by-predecessor") return "waiting-queue";
  if (
    ["head-sha-drift", "base-branch-drift", "base-sha-drift"].includes(
      entry.reason,
    )
  )
    return "stale";
  if (["blocked-label", "fork-or-cross-repository-head"].includes(entry.reason))
    return "blocked";
  return "rejected";
}

export function nextAdmissionAction({
  options,
  state,
  reason,
  observedHeadSha = "",
}) {
  const command = [
    "buildchain dev pr-admit",
    `--repository ${options.repository.fullName}`,
    `--branch ${options.targetBranch}`,
    `--pull-request ${options.targetPullRequestNumber}`,
    `--expected-head ${observedHeadSha || options.expectedHeadSha}`,
    "--execute",
  ].join(" ");
  if (state === "queued")
    return `Monitor PR #${options.targetPullRequestNumber} and its native merge-group checks.`;
  if (state === "waiting-approval")
    return `Obtain an independent approval, then rerun: ${command}`;
  if (state === "waiting-checks")
    return `Wait for or repair required checks, then rerun: ${command}`;
  if (state === "waiting-queue")
    return `Wait for the active queue predecessor to finish, then rerun: ${command}`;
  if (state === "stale")
    return `Re-read the PR head and rerun with that exact SHA: ${command}`;
  if (reason === "missing-ready-label")
    return `Declare the exact delivery intent by running: ${command}`;
  if (state === "ready")
    return options.dryRun
      ? `Apply the reviewed plan: ${command}`
      : "Continue with native merge-group qualification.";
  return `Inspect reason ${reason || "unknown"}, repair it, and rerun the exact-head command.`;
}

export function diagnosticState(state) {
  if (["ready", "queued"].includes(state)) return "success";
  if (["waiting-approval", "waiting-checks", "waiting-queue"].includes(state))
    return "pending";
  return "failure";
}

export function renderAdmissionComment(receipt, receiptRoot) {
  const marker = `<!-- ${AGENT_ADMISSION_MARKER} pr=${receipt.pullRequestNumber} head=${receipt.expectedHeadSha} -->`;
  return [
    marker,
    "## Buildchain dev PR admission",
    "",
    `- State: \`${receipt.state}\``,
    `- Reason: \`${receipt.reason}\``,
    `- Exact head: \`${receipt.expectedHeadSha}\``,
    `- Readiness: \`${receipt.readiness.observed ? "present" : "missing"}\` (\`${receipt.readiness.label || "policy-equivalent"}\`)`,
    `- Receipt root: \`${receiptRoot}\``,
    `- Next action: ${receipt.nextAction}`,
    "",
    "GitHub auto-merge state is observed evidence only; it is not Buildchain admission authority.",
  ].join("\n");
}
export async function publishAdmissionDiagnostic(
  client,
  options,
  receipt,
  receiptRoot,
) {
  const marker = `<!-- ${AGENT_ADMISSION_MARKER} pr=${receipt.pullRequestNumber} head=${receipt.expectedHeadSha} -->`;
  const body = renderAdmissionComment(receipt, receiptRoot);
  const comments = await client.listIssueComments(receipt.pullRequestNumber);
  const existing = comments.find((comment) =>
    String(comment.body || "").includes(marker),
  );
  const comment = existing
    ? await client.updateIssueComment(existing.id, body)
    : await client.createIssueComment(receipt.pullRequestNumber, body);
  let status = null;
  if (receipt.expectedHeadSha === receipt.observedHeadSha) {
    status = await client.setCommitStatus(receipt.expectedHeadSha, {
      state: diagnosticState(receipt.state),
      context: options.diagnosticContext,
      description: `${receipt.state}: ${receipt.reason}`.slice(0, 140),
      targetUrl: receipt.pullRequestUrl,
    });
  }
  return {
    commentId: comment?.id || null,
    commentUrl: comment?.html_url || "",
    statusPublished: Boolean(status),
  };
}
export function createAdmissionReceipt({
  options,
  pr = {},
  state,
  reason,
  readiness,
  decision = {},
  queue = null,
  warrant = null,
}) {
  return createDevPrAdmissionReceipt({
    options,
    pr,
    state,
    reason,
    readiness,
    decision,
    queue,
    warrant,
    labels: labelsOf(pr),
    nextAction: nextAdmissionAction,
  });
}

export function targetedFailure({
  options,
  pr,
  state,
  reason,
  readiness,
  decision,
  queue,
}) {
  const receipt = createAdmissionReceipt({
    options,
    pr,
    state,
    reason,
    readiness,
    decision,
    queue,
  });
  return {
    schema: AGENT_ADMISSION_RESULT_SCHEMA,
    ok: false,
    mode: options.dryRun ? "plan" : "execute",
    outcome: "targeted-admission-failed",
    receipt,
    receiptRoot: contentRoot(receipt),
    diagnostic: null,
  };
}
export async function readTargetPullRequest(client, number, options) {
  let { pollMergeableAttempts: attempts, pollMergeableDelayMs: delayMs } =
    options;
  for (; attempts > 1; attempts -= 1) {
    try {
      return await client.getPullRequest(number, { attempts, delayMs });
    } catch {
      await delay(delayMs);
    }
  }
  return client.getPullRequest(number, { attempts, delayMs });
}
function rejectTargetIdentity(pr, options, reject) {
  if (String(pr.state || "open").toLowerCase() !== "open")
    return reject("rejected", "pull-request-not-open");
  if (pr.base?.ref !== options.targetBranch)
    return reject("stale", "base-branch-drift");
  if (String(pr.head?.sha || "").toLowerCase() !== options.expectedHeadSha)
    return reject("stale", "head-sha-drift");
  if (
    !sameRepositoryAllowed(pr, options.repository, options.sameRepositoryOnly)
  )
    return reject("blocked", "fork-or-cross-repository-head");
  if (hasBlockedLabel(pr, options.blockLabels))
    return reject("blocked", "blocked-label");
  if (pr.draft) return reject("blocked", "draft");
  if (!headPrefixAllowed(pr, options.allowedHeadPrefixes))
    return reject("blocked", "head-prefix-not-allowed");

  return null;
}

export async function runDevPrAdmission(optionsInput = {}, clientInput) {
  const options = normalizeOptions(optionsInput);
  if (!options.targetBranch) throw new Error("target branch is required");
  if (!options.targetPullRequestNumber)
    throw new Error("pull request number is required");
  if (!SHA_PATTERN.test(options.expectedHeadSha))
    throw new Error(
      "expected head must be an exact 40-character lowercase Git SHA",
    );
  const client =
    clientInput ||
    (optionsInput.useGhCli
      ? new GhCliClient({ repository: options.repository })
      : new GitHubClient({
          token: optionsInput.token,
          repository: options.repository,
          apiUrl: optionsInput.apiUrl || "https://api.github.com",
        }));

  let pr;
  try {
    pr = await readTargetPullRequest(
      client,
      options.targetPullRequestNumber,
      options,
    );
  } catch (error) {
    return targetedFailure({
      options,
      pr: {},
      state: "blocked",
      reason: "pull-request-read-failed",
    });
  }

  const readinessFence = createPreReadinessQueueFence({
    client,
    options,
    sleep: delay,
  });
  const reject = async (
    state,
    reason,
    readiness = {
      observed: hasReadyLabel(pr, options.readyLabel),
      established: false,
    },
  ) => {
    const result = targetedFailure({ options, pr, state, reason, readiness });
    await readinessFence.finish(result);
    if (!options.dryRun)
      result.diagnostic = await publishAdmissionDiagnostic(
        client,
        options,
        result.receipt,
        result.receiptRoot,
      );
    return result;
  };
  const rejected = rejectTargetIdentity(pr, options, reject);
  if (rejected) return rejected;

  try {
    await readinessFence.establish();
  } catch (error) {
    return reject("blocked", error.code || "pre-readiness-queue-fence-failed");
  }

  let readiness = {
    observed: hasReadyLabel(pr, options.readyLabel),
    established: false,
  };
  if (!readiness.observed) {
    if (options.dryRun)
      return reject("rejected", "missing-ready-label", readiness);
    await client.addLabels(pr.number, [options.readyLabel]);
    const readback = await client.getPullRequest(pr.number, {
      attempts: options.pollMergeableAttempts,
      delayMs: options.pollMergeableDelayMs,
    });
    if (
      String(readback.head?.sha || "").toLowerCase() !== options.expectedHeadSha
    ) {
      pr = readback;
      return reject("stale", "head-sha-drift-after-readiness-write", readiness);
    }
    if (readback.base?.ref !== options.targetBranch) {
      pr = readback;
      return reject(
        "stale",
        "base-branch-drift-after-readiness-write",
        readiness,
      );
    }
    pr = readback;
    readiness = {
      observed: hasReadyLabel(pr, options.readyLabel),
      established: true,
    };
    if (!readiness.observed)
      return reject("rejected", "readiness-readback-failed", readiness);
  }

  if (options.qualificationOnly) {
    const result = await runSourceQualification({
      options,
      pullRequest: pr,
      readiness,
      client,
      reject,
      evaluate: evaluatePullRequest,
      admissionState: admissionStateFor,
      createReceipt: createAdmissionReceipt,
      root: contentRoot,
      publishDiagnostic: publishAdmissionDiagnostic,
    });
    return readinessFence.finish(result);
  }

  const initialQueue = await client.getMergeQueueState(options.targetBranch);
  let warrant = null;
  try {
    warrant = readDeliveryWarrantResult(options, pr);
    await verifyCurrentDeliveryWarrant(client, options, pr, warrant);
  } catch (error) {
    return reject("blocked", error.code || "invalid-delivery-warrant");
  }
  const matchingEntry = initialQueue.entries.find(
    (entry) =>
      entry.pullRequestNumber === pr.number &&
      entry.pullRequestHeadSha === options.expectedHeadSha,
  );
  await readinessFence.qualifyExisting(matchingEntry);
  const existing = await admitExistingQueueEntry({
    options,
    pullRequest: pr,
    readiness,
    client,
    entry: matchingEntry,
    warrant,
    createReceipt: createAdmissionReceipt,
    root: contentRoot,
    publishDiagnostic: publishAdmissionDiagnostic,
  });
  if (existing) return existing;

  const result = await runTargetedQueueAdmission({
    options,
    pullRequest: pr,
    readiness,
    client,
    warrant,
    runController: runDevPrAutoMerge,
    admissionState: admissionStateFor,
    createReceipt: createAdmissionReceipt,
    root: contentRoot,
    publishDiagnostic: publishAdmissionDiagnostic,
  });
  return readinessFence.finish(result);
}
