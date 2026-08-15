import { isDeepStrictEqual } from "node:util";
import {
  createDevDeliveryQueue,
  devDeliveryContentRoot,
  normalizeDevDeliveryQueue,
} from "../packages/core/dev-delivery-warrant.js";
import { normalizeDevDeliveryAuthorityState } from "../packages/core/dev-delivery-authority-state.js";

const STATE_PATH = "queue.json";

function text(value = "") {
  return String(value ?? "").trim();
}

function exactSha(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return normalized;
}

function normalizeRepository(value) {
  const normalized = text(value);
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(
      `repository must be owner/repo, got ${normalized || "<empty>"}`,
    );
  }
  return { owner: match[1], repo: match[2], fullName: normalized };
}

function encodeRef(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function decodeBlob(blob) {
  if (blob.encoding !== "base64")
    throw new Error(
      `unsupported Git blob encoding ${blob.encoding || "<empty>"}`,
    );
  return Buffer.from(
    String(blob.content || "").replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
}

function validateStoredState(queue) {
  const body = structuredClone(queue || {});
  const embeddedStateRoot = body.stateRoot;
  delete body.stateRoot;
  if (embeddedStateRoot !== devDeliveryContentRoot(body)) {
    throw new Error("dev delivery persisted stateRoot drift");
  }
  if (
    queue?.contract === "kungfu-buildchain-dev-delivery-authority" &&
    Number(queue?.schemaVersion) === 2
  ) {
    normalizeDevDeliveryAuthorityState(queue);
  } else {
    normalizeDevDeliveryQueue(queue);
  }
  return queue;
}

export class GitHubDevDeliveryStore {
  constructor({
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = globalThis.fetch,
    createInitialState = createDevDeliveryQueue,
  } = {}) {
    this.repository = normalizeRepository(repository);
    if (!fetchImpl) throw new Error("fetch is required");
    if (!token)
      throw new Error(
        "GITHUB_TOKEN is required for the GitHub dev delivery store",
      );
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.createInitialState = createInitialState;
  }

  async request(method, requestPath, body) {
    const response = await this.fetch(`${this.apiUrl}${requestPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
      const error = new Error(
        data?.message || raw || `${method} ${requestPath} failed`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async read({ stateRef, protectedBase, now }) {
    let ref;
    try {
      ref = await this.request(
        "GET",
        `/repos/${this.repository.fullName}/git/ref/heads/${encodeRef(stateRef)}`,
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      return {
        exists: false,
        commitSha: "",
        queue: this.createInitialState({
          repository: this.repository.fullName,
          protectedBase,
          now,
        }),
      };
    }
    const commitSha = exactSha(ref?.object?.sha, "state ref commit");
    const readback = await this.readCommit(commitSha);
    return { exists: true, ...readback };
  }

  async readCommit(commitShaInput) {
    const commitSha = exactSha(commitShaInput, "state commit");
    const commit = await this.request(
      "GET",
      `/repos/${this.repository.fullName}/git/commits/${commitSha}`,
    );
    const tree = await this.request(
      "GET",
      `/repos/${this.repository.fullName}/git/trees/${commit.tree?.sha}`,
    );
    const entry = (tree.tree || []).find(
      (item) => item.path === STATE_PATH && item.type === "blob",
    );
    if (!entry?.sha)
      throw new Error(`${commitSha} does not contain ${STATE_PATH}`);
    const blob = await this.request(
      "GET",
      `/repos/${this.repository.fullName}/git/blobs/${entry.sha}`,
    );
    const bytes = decodeBlob(blob);
    const queue = validateStoredState(JSON.parse(bytes));
    return { commitSha, queue, bytes };
  }

  async write({
    stateRef,
    queue,
    expectedCommitSha,
    expectedStateRoot,
    receiptRoot,
  }) {
    if (queue.stateRoot === expectedStateRoot)
      throw new Error("state transition did not advance the queue root");
    validateStoredState(queue);
    const expectedBytes = `${JSON.stringify(queue, null, 2)}\n`;
    const blob = await this.request(
      "POST",
      `/repos/${this.repository.fullName}/git/blobs`,
      {
        content: expectedBytes,
        encoding: "utf-8",
      },
    );
    const tree = await this.request(
      "POST",
      `/repos/${this.repository.fullName}/git/trees`,
      {
        tree: [
          { path: STATE_PATH, mode: "100644", type: "blob", sha: blob.sha },
        ],
      },
    );
    const commit = await this.request(
      "POST",
      `/repos/${this.repository.fullName}/git/commits`,
      {
        message: `chore(dev-delivery): advance Warrant queue ${receiptRoot.slice(0, 20)}`,
        tree: tree.sha,
        parents: expectedCommitSha ? [expectedCommitSha] : [],
      },
    );
    if (expectedCommitSha) {
      await this.request(
        "PATCH",
        `/repos/${this.repository.fullName}/git/refs/heads/${encodeRef(stateRef)}`,
        { sha: commit.sha, force: false },
      );
    } else {
      await this.request(
        "POST",
        `/repos/${this.repository.fullName}/git/refs`,
        {
          ref: `refs/heads/${stateRef}`,
          sha: commit.sha,
        },
      );
    }
    const readback = await this.readCommit(commit.sha);
    if (
      readback.commitSha !== commit.sha ||
      readback.bytes !== expectedBytes ||
      !isDeepStrictEqual(readback.queue, queue)
    ) {
      throw new Error(
        "dev delivery state commit readback mismatch after expected-old update",
      );
    }
    return { commitSha: commit.sha, stateRoot: readback.queue.stateRoot };
  }
}
