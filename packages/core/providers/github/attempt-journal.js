import { createHash } from "node:crypto";
import {
  canonicalJson,
  recordDigest,
} from "../../release/discussion/envelope.js";
import { validateJournal } from "../../workflow/attempt/journal.js";

const PATH = "attempt.json";
const LIMIT = 34 * 1024 * 1024;

function exactSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value || ""))
    throw new Error("Attempt journal requires an exact Git SHA");
  return value;
}

export function githubAttemptJournal(request) {
  function coordinates(intent) {
    if (
      !/^[\w.-]+\/[\w.-]+$/u.test(intent.repository) ||
      !/^sha256:[0-9a-f]{64}$/u.test(intent.id)
    )
      throw new Error("Invalid attempt journal coordinates");
    return {
      base: `/repos/${intent.repository}`,
      ref: `buildchain/attempts/${intent.id.slice(7)}`,
    };
  }
  async function verifyRepository(intent, base) {
    const repository = await request(base);
    if (repository.node_id !== intent.source.repositoryId)
      throw new Error("Attempt repository identity changed");
  }
  async function read(intent) {
    const { base, ref } = coordinates(intent);
    await verifyRepository(intent, base);
    const pointer = await request(`${base}/git/ref/heads/${ref}`, {
      allow404: true,
    });
    if (!pointer) return null;
    if (pointer.object?.type !== "commit")
      throw new Error("Attempt journal ref is not a commit");
    const result = await readCommit(intent.repository, pointer.object.sha);
    validateJournal(result.snapshot, intent);
    return result;
  }
  async function readCommit(repository, commitSha) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
      throw new Error("Invalid attempt journal repository");
    const base = `/repos/${repository}`;
    const sha = exactSha(commitSha);
    const commit = await request(`${base}/git/commits/${sha}`);
    const tree = await request(
      `${base}/git/trees/${exactSha(commit.tree?.sha)}`,
    );
    if (
      tree.truncated ||
      tree.tree?.length !== 1 ||
      tree.tree[0].path !== PATH ||
      tree.tree[0].type !== "blob" ||
      tree.tree[0].mode !== "100644"
    )
      throw new Error("Invalid attempt journal tree");
    const blobSha = exactSha(tree.tree[0].sha);
    const blob = await request(`${base}/git/blobs/${blobSha}`);
    if (
      blob.encoding !== "base64" ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0 ||
      blob.size > LIMIT ||
      typeof blob.content !== "string" ||
      blob.content.length > LIMIT * 2
    )
      throw new Error("Invalid or oversized attempt journal blob");
    const bytes = Buffer.from(blob.content, "base64");
    const digest = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.length !== blob.size || digest !== blobSha)
      throw new Error("Attempt journal blob integrity mismatch");
    const snapshot = JSON.parse(bytes.toString("utf8"));
    if (snapshot.intent?.repository !== repository)
      throw new Error("Attempt journal snapshot belongs to another repository");
    validateJournal(snapshot, snapshot.intent);
    await verifyRepository(snapshot.intent, base);
    return { commit: sha, snapshot };
  }
  async function append({ intent, snapshot, expectedCommit }) {
    validateJournal(snapshot, intent);
    const { base, ref } = coordinates(intent);
    await verifyRepository(intent, base);
    const bytes = `${canonicalJson(snapshot)}\n`;
    if (Buffer.byteLength(bytes) > LIMIT)
      throw new Error("Attempt journal byte bound exceeded");
    const blob = await request(`${base}/git/blobs`, {
      method: "POST",
      body: { content: bytes, encoding: "utf-8" },
    });
    const tree = await request(`${base}/git/trees`, {
      method: "POST",
      body: {
        tree: [
          { path: PATH, mode: "100644", type: "blob", sha: exactSha(blob.sha) },
        ],
      },
    });
    const commit = await request(`${base}/git/commits`, {
      method: "POST",
      body: {
        message: `chore(attempt): append ${snapshot.root}`,
        tree: exactSha(tree.sha),
        parents: expectedCommit ? [exactSha(expectedCommit)] : [],
      },
    });
    const sha = exactSha(commit.sha);
    if (expectedCommit)
      await request(`${base}/git/refs/heads/${ref}`, {
        method: "PATCH",
        body: { sha, force: false },
      });
    else
      await request(`${base}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref}`, sha },
      });
    return { commit: sha };
  }
  async function lookup(repository, pullRequest, targetBranch) {
    if (
      !Number.isSafeInteger(pullRequest) ||
      pullRequest < 1 ||
      !/^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u.test(
        targetBranch || "",
      ) ||
      targetBranch.includes("..")
    )
      throw new Error("Invalid pipeline intent lookup");
    const id = recordDigest({
      repository,
      key: `pr-${pullRequest}:${targetBranch}`,
    });
    const { base, ref } = coordinates({ repository, id });
    const pointer = await request(`${base}/git/ref/heads/${ref}`, {
      allow404: true,
    });
    if (!pointer) return null;
    const result = await readCommit(repository, pointer.object?.sha);
    if (result.snapshot.intent.id !== id)
      throw new Error("Pipeline intent lookup drift");
    return result;
  }
  return { read, append, readCommit, lookup };
}
