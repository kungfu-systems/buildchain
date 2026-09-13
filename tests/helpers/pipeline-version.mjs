import fs from "node:fs";
import { createHash } from "node:crypto";
import { compileConsumerPlan } from "../../packages/core/consumer/contract/plan.js";
import { planPipelinePublication } from "../../packages/core/publication/pipeline/plan.js";
import { githubPipelineVersion } from "../../packages/core/providers/github/pipeline-version.js";

const hash = (value) =>
  createHash("sha1").update(JSON.stringify(value)).digest("hex");
export function pipelineVersionFixture({
  lostResponse = false,
  tamper = false,
  mode = "100644",
} = {}) {
  const repository = "example/product",
    base = `/repos/${repository}`,
    blobs = new Map(),
    trees = new Map(),
    commits = new Map(),
    refs = new Map(),
    writes = [];
  function blob(text) {
    const bytes = Buffer.from(text),
      sha = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    blobs.set(sha, {
      sha,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    });
    return sha;
  }
  const original = '{"version":"1.0.0-alpha.1","keep":"untouched"}';
  const tree = [
      { path: "package.json", type: "blob", mode, sha: blob(original) },
    ],
    treeSha = hash(tree),
    commitSha = "a".repeat(40);
  trees.set(treeSha, { sha: treeSha, tree, truncated: false });
  commits.set(commitSha, {
    sha: commitSha,
    tree: { sha: treeSha },
    parents: [],
    committer: { date: "2026-09-13T00:00:00Z" },
  });
  const source = { repository, commit: commitSha, tree: treeSha };
  const contract = compileConsumerPlan(
    fs.readFileSync(
      "templates/minimal-consumer/npm/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const plan = planPipelinePublication({
    attempt: "attempt",
    generation: "generation",
    source,
    runtime: {},
    publisher: {},
    contract,
    route: contract.channels[2],
    version: "1.0.0-alpha.1",
    sourceTimestamp: "2026-09-13T00:00:00Z",
  });
  async function request(url, options = {}) {
    const suffix = url.slice(base.length),
      body = options.body;
    if (options.method === "POST") {
      writes.push({ url, body });
      if (suffix === "/git/trees") {
        const tree = trees
          .get(body.base_tree)
          .tree.map((item) => ({ ...item }));
        for (const item of body.tree) {
          const content = tamper
            ? item.content.replace("untouched", "changed")
            : item.content;
          Object.assign(
            tree.find((entry) => entry.path === item.path),
            { sha: blob(content) },
          );
        }
        const sha = hash(tree);
        trees.set(sha, { sha, tree, truncated: false });
        return { sha };
      }
      if (suffix === "/git/commits") {
        const sha = hash(body);
        commits.set(sha, {
          ...body,
          sha,
          tree: { sha: body.tree },
          parents: body.parents.map((sha) => ({ sha })),
        });
        return { sha };
      }
      if (suffix === "/git/refs") {
        const key = body.ref.replace(/^refs\//u, "");
        if (refs.has(key)) throw new Error("ref exists");
        refs.set(key, body.sha);
        if (lostResponse) throw new Error("response lost after ref creation");
        return { object: { sha: body.sha } };
      }
    }
    if (suffix.startsWith("/git/commits/"))
      return structuredClone(commits.get(suffix.slice(13)));
    if (suffix.startsWith("/git/trees/"))
      return structuredClone(trees.get(suffix.slice(11).split("?")[0]));
    if (suffix.startsWith("/git/blobs/"))
      return structuredClone(blobs.get(suffix.slice(11)));
    if (suffix.startsWith("/git/ref/"))
      return { object: { sha: refs.get(suffix.slice(9)) } };
    if (suffix.startsWith("/compare/"))
      return {
        status: "ahead",
        total_commits: 1,
        files: [{ filename: "package.json", status: "modified" }],
      };
    throw new Error(`Unexpected provider call: ${url}`);
  }
  return {
    plan,
    contract,
    request,
    commits,
    provider: githubPipelineVersion(request, repository),
    writes,
    refs,
  };
}
