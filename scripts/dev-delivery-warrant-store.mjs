// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  assertDevDeliveryQueue,
  canonical,
  contentRoot,
  exactSha,
  createDevDeliveryQueue,
  repositoryName,
  requiredText,
} from "./dev-delivery-warrant-contract.mjs";
import {
  applyDevDeliveryCommand,
  projectDevDeliveryQueue,
} from "./dev-delivery-warrant-queue.mjs";
import { createGithubEnqueueReceipt } from "./dev-delivery-proof.mjs";
import { GhCliClient, GitHubClient } from "./dev-pr-auto-merge.mjs";

function apiData(response) {
  return response && typeof response === "object" && "data" in response
    ? response.data
    : response;
}

function stateLocation({ repository, stateRef, statePath } = {}) {
  const normalizedRepository = repositoryName(repository);
  const normalizedRef = requiredText(stateRef, "state ref").replace(
    /^refs\/heads\//u,
    "",
  );
  if (
    normalizedRef.startsWith("-") ||
    /[\s~^:?*[\\]/u.test(normalizedRef) ||
    !normalizedRef.startsWith("buildchain-state/dev-delivery/")
  ) {
    throw new Error("state ref must be under buildchain-state/dev-delivery/");
  }
  const normalizedPath = requiredText(
    statePath || ".buildchain/state/dev-delivery-warrant-queue.json",
    "state path",
  );
  if (
    normalizedPath.startsWith("/") ||
    normalizedPath.split("/").includes("..") ||
    !normalizedPath.startsWith(".buildchain/state/")
  ) {
    throw new Error("state path must be under .buildchain/state/");
  }
  return {
    repository: normalizedRepository,
    stateRef: normalizedRef,
    statePath: normalizedPath,
    encodedPath: normalizedPath.split("/").map(encodeURIComponent).join("/"),
  };
}

export async function loadPersistedDevDeliveryQueue({ api, ...input } = {}) {
  if (!api?.request) throw new Error("GitHub API client is required");
  const location = stateLocation(input);
  const response = apiData(
    await api.request(
      "GET",
      `/repos/${location.repository}/contents/${location.encodedPath}?ref=${encodeURIComponent(location.stateRef)}`,
    ),
  );
  if (!response || Array.isArray(response) || response.type === "dir") {
    throw new Error("dev delivery queue state path is not a file");
  }
  if (response.encoding !== "base64" || !response.content) {
    throw new Error("dev delivery queue state response is not base64 content");
  }
  let state;
  try {
    state = JSON.parse(
      Buffer.from(response.content, "base64").toString("utf8"),
    );
  } catch (error) {
    throw new Error(
      `cannot decode persisted dev delivery queue: ${error.message}`,
    );
  }
  assertDevDeliveryQueue(state);
  if (state.repository !== location.repository) {
    throw new Error("persisted queue repository binding mismatch");
  }
  return {
    ...location,
    state,
    blobSha: requiredText(response.sha, "persisted state blob SHA"),
    providerUrl: response.html_url || "",
  };
}

export async function persistDevDeliveryQueue({
  api,
  state,
  expectedBlobSha = "",
  message = "chore(delivery): advance dev Warrant queue",
  ...input
} = {}) {
  if (!api?.request) throw new Error("GitHub API client is required");
  assertDevDeliveryQueue(state);
  const location = stateLocation(input);
  if (state.repository !== location.repository) {
    throw new Error("queue repository does not match persistence repository");
  }
  const body = {
    branch: location.stateRef,
    message: requiredText(message, "state commit message"),
    content: Buffer.from(
      `${JSON.stringify(canonical(state), null, 2)}\n`,
      "utf8",
    ).toString("base64"),
    ...(expectedBlobSha
      ? { sha: requiredText(expectedBlobSha, "expected blob SHA") }
      : {}),
  };
  let response;
  try {
    response = apiData(
      await api.request(
        "PUT",
        `/repos/${location.repository}/contents/${location.encodedPath}`,
        { body },
      ),
    );
  } catch (error) {
    if ([409, 422].includes(Number(error.status || error.response?.status))) {
      const stale = new Error(
        "persisted queue compare-and-set rejected stale state",
      );
      stale.code = "STALE_PROVIDER_STATE";
      throw stale;
    }
    throw error;
  }
  const receipt = {
    schema: "kungfu-buildchain-dev-delivery-state-persistence/v1",
    repository: location.repository,
    stateRef: location.stateRef,
    statePath: location.statePath,
    expectedBlobSha,
    newBlobSha: requiredText(response?.content?.sha, "new state blob SHA"),
    commitSha: exactSha(response?.commit?.sha, "state commit SHA"),
    queueRevision: state.revision,
  };
  return {
    ...receipt,
    receiptRoot: contentRoot(receipt),
    providerUrl: response?.content?.html_url || "",
  };
}

export async function applyPersistedDevDeliveryCommand({
  api,
  command,
  ...input
} = {}) {
  if (command?.action === "enqueue-github") {
    return enqueuePersistedDevDeliveryCandidate({ api, command, ...input });
  }
  if (command?.action === "observe-merged") {
    return observePersistedDevDeliveryMerge({ api, command, ...input });
  }
  const loaded = await loadPersistedDevDeliveryQueue({ api, ...input });
  const transition = applyDevDeliveryCommand(loaded.state, command);
  if (transition.state.revision === loaded.state.revision) {
    return {
      ...transition,
      persistence: {
        schema: "kungfu-buildchain-dev-delivery-state-persistence/v1",
        action: "no-op",
        expectedBlobSha: loaded.blobSha,
        newBlobSha: loaded.blobSha,
        queueRevision: loaded.state.revision,
      },
    };
  }
  const persistence = await persistDevDeliveryQueue({
    api,
    ...input,
    state: transition.state,
    expectedBlobSha: loaded.blobSha,
  });
  return { ...transition, persistence };
}

function activeCandidate(state) {
  const submissionId = state.activeWarrant?.submissionId;
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === submissionId,
  );
  if (!candidate) throw new Error("active Warrant candidate is missing");
  return candidate;
}

async function pullRequest(api, repository, number) {
  if (typeof api.getPullRequest === "function") {
    return api.getPullRequest(number, { attempts: 1, delayMs: 0 });
  }
  return apiData(
    await api.request("GET", `/repos/${repository}/pulls/${number}`),
  );
}

async function persistTransition(loaded, transition, api, input) {
  const persistence = await persistDevDeliveryQueue({
    api,
    ...input,
    state: transition.state,
    expectedBlobSha: loaded.blobSha,
  });
  return { ...transition, persistence };
}

export async function enqueuePersistedDevDeliveryCandidate({
  api,
  command,
  ...input
} = {}) {
  const loaded = await loadPersistedDevDeliveryQueue({ api, ...input });
  const candidate = activeCandidate(loaded.state);
  const planned = applyDevDeliveryCommand(loaded.state, command);
  const pr = await pullRequest(
    api,
    loaded.state.repository,
    candidate.pullRequestNumber,
  );
  const observedHeadSha = exactSha(pr?.head?.sha, "observed PR head SHA");
  if (observedHeadSha !== candidate.sourceHeadSha) {
    throw new Error("PR head changed before Warrant-owned enqueue");
  }
  if (pr?.base?.ref && pr.base.ref !== loaded.state.protectedBase) {
    throw new Error("PR base changed before Warrant-owned enqueue");
  }
  const pullRequestId = requiredText(pr?.node_id, "pull request node id");
  let entry = null;
  if (typeof api.getMergeQueueState === "function") {
    const queue = await api.getMergeQueueState(loaded.state.protectedBase);
    entry = (queue?.entries || []).find(
      (item) =>
        item.pullRequestNumber === candidate.pullRequestNumber &&
        item.pullRequestHeadSha === candidate.sourceHeadSha,
    );
  }
  let recovered = Boolean(entry);
  if (!entry) {
    try {
      entry = await api.enqueuePullRequest({
        pullRequestId,
        expectedHeadOid: candidate.sourceHeadSha,
      });
    } catch (error) {
      const failed = applyDevDeliveryCommand(loaded.state, {
        ...command,
        action: "enqueue-rejected",
        reason: "github-enqueue-rejected",
      });
      const persisted = await persistTransition(loaded, failed, api, input);
      return {
        ...persisted,
        status: "failed",
        enqueueError: {
          code: String(error?.code || statusOf(error) || "provider-error"),
          message: String(
            error?.message || "GitHub rejected merge queue admission",
          ),
        },
      };
    }
  }
  if (
    entry.pullRequestNumber !== candidate.pullRequestNumber ||
    entry.pullRequestHeadSha !== candidate.sourceHeadSha
  ) {
    throw new Error("GitHub merge queue entry exact-head readback mismatch");
  }
  const persisted = await persistTransition(loaded, planned, api, input);
  const providerReceipt = createGithubEnqueueReceipt({
    repository: loaded.state.repository,
    protectedBase: loaded.state.protectedBase,
    submissionId: candidate.submissionId,
    sourceHeadSha: candidate.sourceHeadSha,
    warrant: loaded.state.activeWarrant,
    queueEntryId: requiredText(entry.id, "merge queue entry id"),
    queueEntryState: requiredText(entry.state, "merge queue entry state"),
    recoveredAfterControllerRestart: recovered,
    queueRevision: persisted.state.revision,
  });
  return {
    ...persisted,
    status: "merge-queued",
    providerReceipt,
  };
}

export async function observePersistedDevDeliveryMerge({
  api,
  command,
  ...input
} = {}) {
  const loaded = await loadPersistedDevDeliveryQueue({ api, ...input });
  const candidate = activeCandidate(loaded.state);
  if (!candidate.proofs?.integrationDeliveryRoot) {
    throw new Error(
      "merge observation requires an exact Integration Delivery Proof",
    );
  }
  const pr = await pullRequest(
    api,
    loaded.state.repository,
    candidate.pullRequestNumber,
  );
  if (pr?.merged !== true) throw new Error("pull request is not merged");
  const mergedHeadSha = exactSha(pr?.merge_commit_sha, "merged PR head SHA");
  if (typeof api.getBranchSha !== "function") {
    throw new Error("protected branch exact-head readback is required");
  }
  const protectedHeadSha = exactSha(
    await api.getBranchSha(loaded.state.protectedBase),
    "protected branch head SHA",
  );
  if (protectedHeadSha !== mergedHeadSha) {
    throw new Error("protected branch head does not match merged PR head");
  }
  const transition = applyDevDeliveryCommand(loaded.state, {
    ...command,
    mergedHeadSha,
  });
  return {
    ...(await persistTransition(loaded, transition, api, input)),
    status: "merged",
    protectedHeadSha,
  };
}

function statusOf(error) {
  return Number(error?.status || error?.response?.status || 0);
}

export async function bootstrapPersistedDevDeliveryQueue({
  api,
  repository,
  protectedBase,
  stateRef,
  statePath,
  now,
  expectedBaseSha = "",
  agingQuantumSeconds,
  warrantTtlSeconds,
} = {}) {
  const location = stateLocation({ repository, stateRef, statePath });
  try {
    const loaded = await loadPersistedDevDeliveryQueue({ api, ...location });
    return { action: "existing", ...loaded };
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  const branch = apiData(
    await api.request(
      "GET",
      `/repos/${location.repository}/branches/${encodeURIComponent(protectedBase)}`,
    ),
  );
  const baseSha = exactSha(branch?.commit?.sha, "protected base SHA");
  if (
    expectedBaseSha &&
    exactSha(expectedBaseSha, "expected base SHA") !== baseSha
  ) {
    throw new Error("protected base SHA changed before queue bootstrap");
  }
  let createdRef = false;
  try {
    await api.request(
      "GET",
      `/repos/${location.repository}/git/ref/heads/${encodeURIComponent(location.stateRef)}`,
    );
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    try {
      await api.request("POST", `/repos/${location.repository}/git/refs`, {
        body: { ref: `refs/heads/${location.stateRef}`, sha: baseSha },
      });
      createdRef = true;
    } catch (createError) {
      if (statusOf(createError) !== 422) throw createError;
    }
  }
  const state = createDevDeliveryQueue({
    repository: location.repository,
    protectedBase,
    now,
    agingQuantumSeconds,
    warrantTtlSeconds,
  });
  try {
    const persistence = await persistDevDeliveryQueue({
      api,
      ...location,
      state,
      message: "chore(delivery): initialize Dev Warrant queue",
    });
    return { action: "created", createdRef, state, persistence, baseSha };
  } catch (error) {
    if (error.code !== "STALE_PROVIDER_STATE") throw error;
    const loaded = await loadPersistedDevDeliveryQueue({ api, ...location });
    return {
      action: "adopted-concurrent-bootstrap",
      createdRef,
      ...loaded,
      baseSha,
    };
  }
}

function cliValue(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: buildchain dev warrant --repository owner/repo --state-ref buildchain-state/dev-delivery/<id> [--init --branch dev/vN/vN.M | --command FILE | --view] [--output FILE] [--gh-cli]\n",
    );
    return;
  }
  const repository = cliValue(
    args,
    "repository",
    process.env.GITHUB_REPOSITORY,
  );
  const stateRef = cliValue(args, "state-ref");
  const statePath = cliValue(args, "state-path");
  const outputPath = cliValue(
    args,
    "output",
    ".buildchain/dev-delivery-warrant/result.json",
  );
  const [owner, repo] = repositoryName(repository).split("/");
  const repositoryIdentity = { owner, repo, fullName: `${owner}/${repo}` };
  const client =
    args.includes("--gh-cli") || !process.env.GITHUB_TOKEN
      ? new GhCliClient({ repository: repositoryIdentity })
      : new GitHubClient({
          token: process.env.GITHUB_TOKEN,
          repository: repositoryIdentity,
        });
  let result;
  if (args.includes("--init")) {
    result = await bootstrapPersistedDevDeliveryQueue({
      api: client,
      repository,
      protectedBase: cliValue(args, "branch"),
      expectedBaseSha: cliValue(args, "expected-base"),
      stateRef,
      statePath,
      now: cliValue(args, "now", new Date().toISOString()),
    });
  } else if (args.includes("--view")) {
    const loaded = await loadPersistedDevDeliveryQueue({
      api: client,
      repository,
      stateRef,
      statePath,
    });
    result = projectDevDeliveryQueue(
      loaded.state,
      cliValue(args, "now", new Date().toISOString()),
    );
  } else {
    const commandPath = cliValue(args, "command");
    if (!commandPath)
      throw new Error("--command FILE is required for a mutation");
    const command = JSON.parse(fs.readFileSync(commandPath, "utf8"));
    result = await applyPersistedDevDeliveryCommand({
      api: client,
      repository,
      stateRef,
      statePath,
      command,
    });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
