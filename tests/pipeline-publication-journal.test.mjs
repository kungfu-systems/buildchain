import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { openPipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { preparePipelinePublication } from "../packages/core/publication/pipeline/prepare.js";
import { publicationContext } from "../packages/core/publication/pipeline/context.js";

async function publicationFixture() {
  const f = pipelineHostFixture();
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
    throw new Error(`Unexpected publication provider path: ${url}`);
  };
  f.host.productArchive = () => ({});
  return { f, publisher, merge, complete, attempt: session.observed.attempt };
}

test("publication freezes the real protected source and defining publisher, and fences duplicate/late workers across jobs", async () => {
  const { f, publisher, merge, complete, attempt } = await publicationFixture();
  const first = await preparePipelinePublication(attempt, publisher, f.host);
  assert.equal(first.operation, "build");
  assert.equal(first.context.plan.source.commit, merge.commit);
  assert.notEqual(first.context.plan.source.commit, f.f.source.commit);
  assert.equal(first.context.plan.publisher.workflowSha, publisher);
  assert.notEqual(
    first.context.plan.publisher.workflowSha,
    first.context.plan.runtime.commit,
  );
  await publicationContext(first.context, f.host);
  const secondHost = {
    ...f.host,
    runId: 201,
    writer: { ...f.host.writer, runId: "201", jobId: "22" },
  };
  assert.equal(
    (await preparePipelinePublication(attempt, publisher, secondHost))
      .operation,
    "wait",
  );
  complete.add(200);
  const resumed = await preparePipelinePublication(
    attempt,
    publisher,
    secondHost,
  );
  assert.deepEqual(resumed.context.plan, first.context.plan);
  await assert.rejects(
    publicationContext(first.context, f.host),
    /lost its exact provider/,
  );
  await assert.rejects(
    publicationContext(
      {
        ...resumed.context,
        plan: { ...resumed.context.plan, version: "9.0.0" },
      },
      secondHost,
    ),
    /not retained/,
  );
  await assert.rejects(
    preparePipelinePublication(attempt, "9".repeat(40), secondHost),
    /exact hosted/,
  );
});
