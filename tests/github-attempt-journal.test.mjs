import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { githubAttemptJournal } from "../packages/core/providers/github/attempt-journal.js";
import { atomicAttemptJournal } from "../packages/core/workflow/attempt/journal.js";
import { identities } from "./helpers/business-attempt.mjs";

function githubFixture() {
  const objects = new Map(),
    calls = [];
  let pointer = null,
    corrupt = false,
    lose = false;
  const hash = (kind, bytes) =>
    createHash("sha1")
      .update(`${kind} ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex");
  const put = (kind, value) => {
    const bytes = kind === "blob" ? value : JSON.stringify(value);
    const sha = hash(kind, bytes);
    objects.set(
      sha,
      kind === "blob"
        ? {
            encoding: "base64",
            size: Buffer.byteLength(bytes),
            content: Buffer.from(bytes).toString("base64"),
          }
        : value,
    );
    return { sha };
  };
  const request = async (url, options = {}) => {
    const { body, method = "GET" } = options;
    calls.push({ url, method, body });
    if (url === "/repos/example/consumer") return { node_id: "R1" };
    const kind = url.split("/").at(-1);
    if (method === "POST" && kind === "blobs") return put("blob", body.content);
    if (method === "POST" && kind === "trees") return put("tree", body);
    if (method === "POST" && kind === "commits")
      return put("commit", { ...body, tree: { sha: body.tree } });
    if (url.includes("/git/refs")) {
      assert.equal(method, pointer ? "PATCH" : "POST");
      const parents = objects.get(body.sha).parents;
      if (pointer && (parents.length !== 1 || parents[0] !== pointer))
        throw new Error("GitHub API 422 non-fast-forward");
      if (pointer) assert.equal(body.force, false);
      pointer = body.sha;
      if (lose) throw new Error("Disconnected after remote update");
      return {};
    }
    if (url.includes("/git/ref/"))
      return pointer ? { object: { type: "commit", sha: pointer } } : undefined;
    const value = structuredClone(objects.get(kind));
    if (!value) throw new Error(`Unexpected provider read ${url}`);
    if (corrupt && value.encoding === "base64")
      value.content = Buffer.from("wrong").toString("base64");
    return value;
  };
  return {
    request,
    calls,
    corrupt: () => {
      corrupt = true;
    },
    lose: () => {
      lose = true;
    },
  };
}

test("GitHub journal commits one parent, rejects stale remote updates and verifies bytes", async () => {
  const f = identities(),
    github = githubFixture();
  const journal = atomicAttemptJournal(
    githubAttemptJournal(github.request),
    f.intent,
  );
  const root = f.event();
  github.lose();
  await journal.append(root, "");
  const results = await Promise.allSettled([
    journal.append(f.event(root, { state: "success" }), root.id),
    journal.append(
      f.event(root, { state: "waiting", reason: "wait" }),
      root.id,
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await journal.read()).snapshot.records.length, 2);
  assert.ok(
    github.calls
      .filter((call) => call.method === "PATCH")
      .every((call) => call.body.force === false),
  );
  github.corrupt();
  await assert.rejects(journal.read(), /integrity mismatch/);
});
