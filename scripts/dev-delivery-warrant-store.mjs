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
  const client =
    args.includes("--gh-cli") || !process.env.GITHUB_TOKEN
      ? new GhCliClient({ repository: { fullName: repository } })
      : new GitHubClient({ token: process.env.GITHUB_TOKEN, repository });
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
