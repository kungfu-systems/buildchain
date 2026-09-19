import { createHash } from "node:crypto";
import { pipelineHostFixture } from "./pipeline-host.mjs";
import { openPipelineSession } from "../../packages/core/workflow/pipeline/session.js";

export async function publicationFixture({ derivedFiles = {} } = {}) {
  const f = pipelineHostFixture();
  if (Object.keys(derivedFiles).length)
    f.admission.plan.version.derived_files = Object.keys(derivedFiles);
  f.admission.route = f.admission.plan.channels[1];
  f.admission.live.targetBranch = f.admission.route.to;
  const session = await openPipelineSession(
    { admission: f.admission, ...f.host },
    f.host,
  );
  for (const phase of ["admission", "build", "review", "merge"])
    await session.progress.progress({
      attempt: session.observed.attempt,
      phase,
      state: "success",
      eventKey: `fixture:${phase}`,
    });
  const publisher = "2".repeat(40),
    merge = { ...f.f.source, commit: "f".repeat(40), tree: "1".repeat(40) };
  const pkg = Buffer.from(
    JSON.stringify({ name: "@example/product", version: "1.0.0-alpha.1" }),
  );
  const blob = createHash("sha1")
    .update(`blob ${pkg.length}\0`)
    .update(pkg)
    .digest("hex");
  const derived = Object.entries(derivedFiles).map(([path, content]) => {
    const bytes = Buffer.from(content);
    return {
      path,
      bytes,
      sha: createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
    };
  });
  const complete = new Set();
  f.host.runId = 200;
  f.host.writer = { ...f.host.writer, runId: "200", jobId: "21" };
  f.host.runs.read = async (id) => ({
    run: {
      id,
      status: complete.has(id) ? "completed" : "in_progress",
      referenced_workflows: [
        {
          path: "kungfu-systems/buildchain/.github/workflows/.release-pipeline-products.yml@v4",
          sha: publisher,
        },
      ],
    },
    jobs: [],
  });
  f.host.integration = { observe: async () => ({ mergeCommit: merge.commit }) };
  f.host.source.source = async (commit) => ({
    identity: commit === merge.commit ? merge : f.f.source,
    plan: f.admission.plan,
  });
  f.host.request = async (url) => {
    if (url.endsWith(`/git/commits/${f.host.runtime.sha}`))
      return { sha: f.host.runtime.sha, tree: { sha: "3".repeat(40) } };
    if (url.endsWith(`/git/commits/${merge.commit}`))
      return {
        sha: merge.commit,
        tree: { sha: merge.tree },
        committer: { date: "2026-09-13T00:00:00Z" },
      };
    if (url.endsWith(`/git/trees/${merge.tree}?recursive=1`))
      return {
        sha: merge.tree,
        truncated: false,
        tree: [
          { path: "package.json", sha: blob, type: "blob", mode: "100644" },
          ...derived.map(({ path, sha }) => ({
            path,
            sha,
            type: "blob",
            mode: "100644",
          })),
        ],
      };
    if (url.endsWith(`/git/blobs/${blob}`))
      return {
        sha: blob,
        encoding: "base64",
        content: pkg.toString("base64"),
        size: pkg.length,
      };
    if (url.includes("/git/ref/tags/")) return undefined;
    const extra = derived.find(({ sha }) => url.endsWith(`/git/blobs/${sha}`));
    if (extra)
      return {
        sha: extra.sha,
        encoding: "base64",
        content: extra.bytes.toString("base64"),
        size: extra.bytes.length,
      };
    throw new Error(`Unexpected publication provider path: ${url}`);
  };
  return { f, publisher, merge, complete, attempt: session.observed.attempt };
}
