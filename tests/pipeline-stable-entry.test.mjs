import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { consumerContractLock } from "../packages/core/consumer/contract/identity.js";
import {
  consumerWorkflows,
  PIPELINE_ENTRY,
} from "../packages/core/consumer/contract/entries.js";
import { recordPipelineBuild } from "../packages/core/workflow/pipeline/build-control.js";
import { githubPipelineRuns } from "../packages/core/providers/github/pipeline-runs.js";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import { readPipelineStableEntry } from "../packages/core/publication/pipeline/stable-entry.js";

const publishedAt = "2026-09-13T00:00:00.000Z";
function rooted(value) {
  const { root, ...body } = value;
  return { ...body, root: recordDigest(body) };
}
function file(value) {
  const bytes = Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  };
}

async function fixture({
  failure = false,
  platforms = ["linux-x64"],
  nativeRuntime,
} = {}) {
  const f = pipelineHostFixture(),
    candidateSha = f.host.runtime.sha;
  if (nativeRuntime) f.host.runtime = { ...f.host.runtime, sha: nativeRuntime };
  f.admission.plan.products[0].platforms = platforms;
  const { context } = await f.event();
  const repository = f.host.repository;
  const caller = ".github/workflows/buildchain.yml";
  const source = context.source;
  const state = {
    calls: [],
    checks: [],
    readonly: false,
    caller: file(consumerWorkflows("v4-alpha", source.configPath)[caller]),
    lock: file(
      consumerContractLock({
        entry: { repository: "kungfu-systems/buildchain", sha: candidateSha },
        runtime: { repository: "kungfu-systems/buildchain", sha: candidateSha },
        configDigest: source.configDigest,
      }),
    ),
    jobs: [
      ...platforms.map((platform, index) => ({
        id: 30 + index,
        run_id: 100,
        run_attempt: 1,
        name: `Build product (${platform})`,
        status: "completed",
        conclusion: failure ? "failure" : "success",
        started_at: "2026-09-13T00:10:00Z",
        completed_at: "2026-09-13T00:15:00Z",
      })),
      {
        id: 12,
        run_id: 100,
        run_attempt: 1,
        name: "Record product build",
        status: "completed",
        conclusion: failure ? "failure" : "success",
        started_at: "2026-09-13T00:15:01Z",
        completed_at: "2026-09-13T00:15:05Z",
      },
    ],
    run: {
      id: 100,
      run_attempt: 1,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      head_sha: source.commit,
      event: "pull_request",
      path: caller,
      status: "completed",
      conclusion: failure ? "failure" : "success",
      created_at: "2026-09-13T00:10:00Z",
      referenced_workflows: [
        {
          path: `kungfu-systems/buildchain/${PIPELINE_ENTRY}@v4-alpha`,
          sha: candidateSha,
        },
      ],
    },
  };
  const request = async (endpoint, options = {}) => {
    const method = options.method || "GET";
    if (state.readonly)
      assert.equal(method, "GET", "entry qualification must remain read-only");
    state.calls.push({ endpoint, method });
    if (endpoint.endsWith("/check-runs") && method === "POST") {
      const check = {
        ...options.body,
        id: 77,
        app: { slug: "github-actions" },
      };
      state.checks.push(check);
      return check;
    }
    if (endpoint.includes("/actions/workflows/buildchain.yml/runs?"))
      return { workflow_runs: [structuredClone(state.run)] };
    if (endpoint.includes("/check-runs?"))
      return { check_runs: structuredClone(state.checks) };
    if (endpoint === `/repos/${repository}/actions/runs/100`)
      return structuredClone(state.run);
    if (
      endpoint ===
      `/repos/${repository}/actions/runs/100/attempts/1/jobs?per_page=100&page=1`
    )
      return { jobs: structuredClone(state.jobs) };
    if (
      endpoint ===
      `/repos/${repository}/contents/${caller}?ref=${source.commit}`
    )
      return state.caller;
    if (
      endpoint ===
      `/repos/${repository}/contents/.buildchain/alpha-contract-lock.json?ref=${source.commit}`
    )
      return state.lock;
    throw new Error(`Unexpected entry provider request ${method} ${endpoint}`);
  };
  f.host.request = request;
  f.host.runs = githubPipelineRuns(request, repository);
  await recordPipelineBuild(context, f.host);
  const contract = f.admission.plan;
  const plan = planPipelinePublication({
    attempt: context.attempt,
    generation: context.generation,
    source: { ...source, commit: "f".repeat(40) },
    intentSource: { ...source, commit: candidateSha },
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: candidateSha,
      tree: "1".repeat(40),
    },
    publisher: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/.release-pipeline-products.yml",
      workflowSha: candidateSha,
      job: "apply",
    },
    contract,
    route: contract.channels[2],
    version: "1.0.0-alpha.1",
    sourceTimestamp: publishedAt,
  });
  const observedSource = rooted({
    schema: "buildchain.pipeline-stable-source/v1",
    planRoot: plan.root,
    contractRoot: plan.contractRoot,
    source: plan.intentSource,
    candidate: {
      id: 7,
      tag: "v1.0.0-alpha.1",
      sha: candidateSha,
      tree: source.tree,
      publishedAt,
    },
  });
  state.readonly = true;
  state.calls = [];
  return { f, plan, source: observedSource, host: f.host, state };
}

test("published entry qualification binds a normal post-release consumer, exact runtime and all declared platforms through native evidence", async () => {
  const f = await fixture({
    platforms: ["linux-x64", "macos-arm64", "windows-x64"],
  });
  const result = await readPipelineStableEntry(f.plan, f.source, f.host);
  assert.equal(result.root, rooted(result).root);
  assert.equal(result.canary.status, "success");
  assert.equal(result.canary.runtimeRef, f.source.candidate.sha);
  assert.equal(result.canary.completedAt, "2026-09-13T00:15:05.000Z");
  assert.equal(result.native.readback.jobs.length, 3);
  assert.notEqual(result.consumer.source.commit, f.source.candidate.sha);
  assert.equal(result.consumer.source.commit, f.state.run.head_sha);
  assert.equal(result.native.attempt, f.f.observed().attempt);
});

test("GitHub-owned check URLs preserve exact normal-entry qualification and ignore other executions", async () => {
  const f = await fixture({
    platforms: ["linux-x64", "macos-arm64", "windows-x64"],
  });
  const check = f.state.checks[0];
  check.details_url = `https://github.com/${f.host.repository}/runs/${check.id}`;
  f.state.checks.push({
    ...structuredClone(check),
    id: 78,
    details_url: `https://github.com/${f.host.repository}/runs/78`,
    external_id: check.external_id.replace(/:100:1$/u, ":101:1"),
    conclusion: "failure",
  });
  const result = await readPipelineStableEntry(f.plan, f.source, f.host);
  assert.equal(result.canary.status, "success");
  assert.equal(result.native.attempt, f.f.observed().attempt);
  assert.equal(result.native.readback.jobs.length, 3);
  f.state.checks[1].external_id = check.external_id;
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /checks disagree/,
  );
});

test("provider check URLs cannot hide another repository, check, run, attempt or native evidence", async () => {
  for (const [field, value, pattern] of [
    ["details_url", "https://github.com/foreign/repo/runs/77"],
    ["details_url", "wrong-check-id"],
    ["external_id", `buildchain:attempt-${"0".repeat(64)}:101:1`],
    ["external_id", `buildchain:attempt-${"0".repeat(64)}:100:2`],
    ["head_sha", "0".repeat(40), /exact native attempt/],
    ["app", { slug: "untrusted" }, /exact native attempt/],
    ["output", { summary: "green" }, /native build material disagree/],
    [
      "external_id",
      `buildchain:attempt-${"0".repeat(64)}:100:1`,
      /another source/,
    ],
  ]) {
    const f = await fixture(),
      check = f.state.checks[0];
    check.details_url = `https://github.com/${f.host.repository}/runs/${check.id}`;
    check[field] =
      value === "wrong-check-id"
        ? `https://github.com/${f.host.repository}/runs/78`
        : value;
    if (pattern)
      await assert.rejects(
        readPipelineStableEntry(f.plan, f.source, f.host),
        pattern,
      );
    else
      assert.equal(
        (await readPipelineStableEntry(f.plan, f.source, f.host)).status,
        "missing",
      );
  }
});

test("a green published entry running the old locked runtime is not candidate qualification", async () => {
  const f = await fixture();
  const value = JSON.parse(Buffer.from(f.state.lock.content, "base64"));
  value.runtime.sha = "0".repeat(40);
  f.state.lock = file(value);
  const result = await readPipelineStableEntry(f.plan, f.source, f.host);
  assert.equal(result.status, "missing");
  assert.equal(result.canary, undefined);
});

test("the normal-entry provider fact cannot replace the native execution runtime", async () => {
  const f = await fixture({ nativeRuntime: "0".repeat(40) });
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /actual runtime/,
  );
});

test("pre-publication jobs and recovery or foreign entry executions cannot qualify", async () => {
  for (const change of [
    (f) => {
      f.state.run.event = "workflow_dispatch";
    },
    (f) => {
      f.state.run.head_repository.full_name = "foreign/repo";
    },
    (f) => {
      f.state.run.referenced_workflows[0].sha = "0".repeat(40);
    },
    (f) => {
      f.state.run.created_at = "2026-09-12T23:00:00Z";
    },
  ]) {
    const f = await fixture();
    change(f);
    assert.equal(
      (await readPipelineStableEntry(f.plan, f.source, f.host)).status,
      "missing",
    );
  }
  const f = await fixture();
  f.source = rooted({
    ...f.source,
    candidate: { ...f.source.candidate, publishedAt: "2026-09-13T00:12:00Z" },
  });
  f.state.run.created_at = "2026-09-13T00:12:00Z";
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /after the exact Alpha publication/,
  );
});

test("a latest failed or unrecorded normal build remains missing qualification", async () => {
  const failed = await fixture({ failure: true });
  assert.equal(
    (await readPipelineStableEntry(failed.plan, failed.source, failed.host))
      .reason,
    "latest-published-entry-build-failed",
  );
  const missing = await fixture();
  missing.state.checks = [];
  assert.equal(
    (await readPipelineStableEntry(missing.plan, missing.source, missing.host))
      .reason,
    "latest-published-entry-build-unrecorded",
  );
});

test("check identity, summaries and copied green jobs cannot substitute native receipt evidence", async () => {
  for (const [change, pattern] of [
    [
      (f) => {
        f.state.checks[0].app.slug = "untrusted";
      },
      /exact native attempt/,
    ],
    [
      (f) => {
        f.state.checks[0].external_id = `buildchain:attempt-${"0".repeat(64)}:100:1`;
      },
      /another source/,
    ],
    [
      (f) => {
        f.state.checks[0].output.summary = "green";
      },
      /native build material disagree/,
    ],
    [
      (f) => {
        f.state.jobs[0].id = 999;
      },
      /original jobs changed/,
    ],
    [
      (f) => {
        f.state.jobs[1].name = "Lookalike recorder";
      },
      /recorder job/,
    ],
    [
      (f) => {
        f.state.caller = file("name: malicious caller\n");
      },
      /minimal workflow contract/,
    ],
  ]) {
    const f = await fixture();
    change(f);
    await assert.rejects(
      readPipelineStableEntry(f.plan, f.source, f.host),
      pattern,
    );
  }
});

test("equivalent repeated checks are retained but conflicting duplicates fail closed", async () => {
  const f = await fixture();
  f.state.checks.push({ ...structuredClone(f.state.checks[0]), id: 78 });
  assert.equal(
    (await readPipelineStableEntry(f.plan, f.source, f.host)).canary.status,
    "success",
  );
  f.state.checks[1].conclusion = "failure";
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /checks disagree/,
  );
});

test("incomplete run pages and a changing qualification inventory cannot silently select an older canary", async () => {
  const f = await fixture(),
    request = f.host.request;
  f.host.request = async (endpoint, options) =>
    endpoint.includes("/actions/workflows/")
      ? { workflow_runs: null }
      : request(endpoint, options);
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /inventory is incomplete/,
  );
  let calls = 0;
  f.host.request = async (endpoint, options) => {
    if (endpoint.includes("/actions/workflows/") && ++calls === 2)
      return { workflow_runs: [f.state.run, { ...f.state.run, id: 101 }] };
    return request(endpoint, options);
  };
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /inventory changed/,
  );
});

test("entry discovery completes every page before selecting and rechecking its candidate", async () => {
  const f = await fixture(),
    request = f.host.request;
  let pages = 0;
  f.host.request = async (endpoint, options) => {
    if (!endpoint.includes("/actions/workflows/"))
      return request(endpoint, options);
    pages++;
    if (endpoint.endsWith("page=1"))
      return {
        workflow_runs: [
          f.state.run,
          ...Array.from({ length: 99 }, (_, index) => ({
            ...f.state.run,
            id: 1000 + index,
            created_at: "2026-09-13T00:05:00Z",
          })),
        ],
      };
    assert.ok(endpoint.endsWith("page=2"));
    return {
      workflow_runs: [
        { ...f.state.run, id: 2000, created_at: "2026-09-13T00:03:00Z" },
      ],
    };
  };
  assert.equal(
    (await readPipelineStableEntry(f.plan, f.source, f.host)).canary.status,
    "success",
  );
  assert.equal(pages, 4);
});

test("a newer unrecorded matching build prevents fallback to an older successful canary", async () => {
  const f = await fixture(),
    request = f.host.request,
    read = f.host.runs.read;
  const newer = { ...f.state.run, id: 101, created_at: "2026-09-13T00:20:00Z" };
  f.host.request = async (endpoint, options) =>
    endpoint.includes("/actions/workflows/")
      ? { workflow_runs: [f.state.run, newer] }
      : request(endpoint, options);
  f.host.runs.read = async (id, attempt) =>
    id === 101
      ? {
          run: newer,
          jobs: f.state.jobs.map((job) => ({ ...job, run_id: 101 })),
        }
      : read(id, attempt);
  const result = await readPipelineStableEntry(f.plan, f.source, f.host);
  assert.equal(result.reason, "latest-published-entry-build-unrecorded");
  assert.equal(result.runId, 101);
});

test("failed or cancelled setup cannot fall back to an older green build, while successful no-op events can", async () => {
  const f = await fixture(),
    request = f.host.request,
    read = f.host.runs.read;
  const newer = {
    ...f.state.run,
    id: 101,
    created_at: "2026-09-13T00:20:00Z",
    conclusion: "failure",
  };
  f.host.request = async (endpoint, options) =>
    endpoint.includes("/actions/workflows/")
      ? { workflow_runs: [f.state.run, structuredClone(newer)] }
      : request(endpoint, options);
  f.host.runs.read = async (id, attempt) =>
    id === 101
      ? {
          run: structuredClone(newer),
          jobs: [
            {
              name: "buildchain / execute / Build product (${{ matrix.platform }})",
              conclusion: "skipped",
            },
          ],
        }
      : read(id, attempt);
  for (const conclusion of ["failure", "cancelled"]) {
    newer.conclusion = conclusion;
    const result = await readPipelineStableEntry(f.plan, f.source, f.host);
    assert.equal(result.status, "missing");
    assert.equal(result.reason, "latest-published-entry-build-unrecorded");
    assert.equal(result.runId, 101);
  }
  newer.conclusion = "success";
  assert.equal(
    (await readPipelineStableEntry(f.plan, f.source, f.host)).canary.status,
    "success",
  );
});

test("an omitted declared platform cannot be hidden by a green recorder", async () => {
  const f = await fixture({
    platforms: ["linux-x64", "macos-arm64", "windows-x64"],
  });
  f.state.jobs = f.state.jobs.filter(
    (job) => job.name !== "Build product (macos-arm64)",
  );
  await assert.rejects(
    readPipelineStableEntry(f.plan, f.source, f.host),
    /one exact provider job/,
  );
});
