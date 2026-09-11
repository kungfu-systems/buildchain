import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectStableReleaseGateReport } from "../packages/core/release/commands/stable-release-gate.mjs";
import { resolvePublicBuildCanaryEvidence } from "../packages/core/release/qualification/canary-evidence.js";
import {
  fetchQualificationArchive,
  readPublicBuildArchive,
} from "../packages/core/providers/github/qualification-artifacts.js";

const repository = "kungfu-systems/buildchain";
const candidateSha = "a".repeat(40);
const digest = (data) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

function archive(summary, duplicate = false) {
  return execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      [
        "import io,sys,zipfile",
        "data=sys.stdin.buffer.read(); out=io.BytesIO()",
        "with zipfile.ZipFile(out,'w') as z:",
        " z.writestr('build-summary.json',data)",
        ...(duplicate ? [" z.writestr('build-summary.json',data)"] : []),
        "sys.stdout.buffer.write(out.getvalue())",
      ].join("\n"),
    ],
    { input: JSON.stringify(summary), stdio: ["pipe", "pipe", "ignore"] },
  );
}

function fixture() {
  const run = {
    id: 42,
    run_attempt: 1,
    head_sha: "b".repeat(40),
    workflow_id: 7,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "completed",
    conclusion: "success",
    name: "Buildchain Alpha Self-Dogfood",
    updated_at: "2026-09-11T12:00:00Z",
  };
  const workflow = {
    id: 7,
    name: run.name,
    path: ".github/workflows/self-build-alpha-dogfood.yml",
  };
  const summary = {
    contract: "kungfu-buildchain-build-summary",
    artifactName: "buildchain",
    git: { repository, sha: run.head_sha, runId: "42", runAttempt: "1" },
    runtime: {
      ref: "v4-alpha",
      workflowShellRef: "v4-alpha",
      sha: candidateSha,
      class: "alpha",
      override: false,
      trustDecision: "entry-selection",
    },
    platformCount: 3,
    platforms: ["linux-x64", "macos", "windows-x64"].map((id) => ({
      platform: { id },
      expectedArtifacts: { ok: true },
      summary: { digest: "c".repeat(64) },
      observability: {
        lifecycle: {
          stages: Object.fromEntries(
            ["install", "build", "verify"].map((stage) => [
              stage,
              { eventCount: 1 },
            ]),
          ),
        },
      },
    })),
  };
  const canary = {
    id: "buildchain-zero-input",
    source: "public-build",
    repository,
    workflow: workflow.name,
    context: "buildchain-canary/buildchain-zero-input",
  };
  const status = {
    context: canary.context,
    state: "success",
    creator: { login: "github-actions[bot]" },
    target_url: `https://github.com/${repository}/actions/runs/42`,
  };
  return { run, workflow, summary, canary, status };
}

async function collect(value, { assets, bytes, fetchArchive } = {}) {
  const buffer = bytes || archive(value.summary);
  return resolvePublicBuildCanaryEvidence({
    repository,
    candidateSha,
    policy: { requiredCanaries: [value.canary] },
    api: async (endpoint) => {
      if (
        endpoint ===
        `/repos/${repository}/commits/${candidateSha}/statuses?per_page=100`
      )
        return [value.status];
      if (endpoint === `/repos/${repository}/actions/runs/42`) return value.run;
      if (endpoint === `/repos/${repository}/actions/workflows/7`)
        return value.workflow;
      if (
        endpoint ===
        `/repos/${repository}/actions/runs/42/artifacts?per_page=100`
      )
        return {
          artifacts: assets || [
            {
              id: 91,
              name: `buildchain-summary-${value.run.head_sha}`,
              expired: false,
              size_in_bytes: buffer.length,
              digest: digest(buffer),
            },
          ],
        };
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    fetchArchive:
      fetchArchive ||
      (async (endpoint) => {
        assert.equal(endpoint, `/repos/${repository}/actions/artifacts/91/zip`);
        return buffer;
      }),
  });
}

test("public canary reads authenticated run artifacts and qualifies the runtime rather than consumer source", async () => {
  const value = fixture();
  assert.notEqual(value.run.head_sha, candidateSha);
  const [evidence] = await collect(value);
  assert.equal(evidence.status, "success");
  assert.equal(evidence.candidateSha, candidateSha);
  assert.equal(evidence.runtimeRefSource, "public-build-summary");
  assert.equal(evidence.completedAt, value.run.updated_at);
  assert.equal(evidence.attestor, "github-actions[bot]");
});

test("green status cannot qualify another workflow, candidate, attempt, override or incomplete platform", async () => {
  for (const mutate of [
    (v) => {
      v.run.head_repository.full_name = "foreign/buildchain";
    },
    (v) => {
      v.workflow.path = ".github/workflows/untrusted.yml";
    },
    (v) => {
      v.run.conclusion = "failure";
    },
    (v) => {
      v.summary.runtime.sha = "d".repeat(40);
    },
    (v) => {
      v.summary.runtime.override = true;
    },
    (v) => {
      v.summary.git.runAttempt = "2";
    },
    (v) => {
      v.summary.platforms.pop();
    },
    (v) => {
      delete v.summary.platforms[0].observability.lifecycle.stages.verify;
    },
  ]) {
    const value = fixture();
    mutate(value);
    await assert.rejects(collect(value));
  }
  const foreign = fixture();
  foreign.status.target_url = "https://github.com/foreign/repo/actions/runs/42";
  assert.equal((await collect(foreign))[0].status, "mismatched");
});

test("public canary rejects missing, expired, ambiguous or corrupted artifacts", async () => {
  const value = fixture();
  await assert.rejects(collect(value, { assets: [] }), /missing/);
  const asset = {
    id: 91,
    name: `buildchain-summary-${value.run.head_sha}`,
    expired: true,
  };
  await assert.rejects(collect(value, { assets: [asset] }), /expired/);
  asset.expired = false;
  await assert.rejects(collect(value, { assets: [asset, asset] }), /ambiguous/);
  await assert.rejects(
    collect(value, { fetchArchive: async () => Buffer.from("corrupt") }),
    /digest/,
  );
  const duplicate = archive(value.summary, true);
  assert.throws(
    () => readPublicBuildArchive(duplicate, digest(duplicate)),
    /invalid public build archive/,
  );
});

test("artifact redirects never forward the API credential and oversized responses are rejected", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://storage.example.test/archive" },
        })
      : new Response(Buffer.from("archive"));
  };
  const input = {
    apiUrl: "https://api.github.com",
    token: "synthetic-test-credential",
    endpoint: `/repos/${repository}/actions/artifacts/91/zip`,
    fetchImpl,
  };
  assert.equal((await fetchQualificationArchive(input)).toString(), "archive");
  assert.equal(calls[1].options.headers, undefined);
  await assert.rejects(
    fetchQualificationArchive({
      ...input,
      fetchImpl: async () =>
        new Response("x", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        }),
    }),
    /size limit/,
  );
});

test("stable gate collector admits public-build policy through the existing report and soak gate", async () => {
  const value = fixture();
  const bytes = archive(value.summary);
  const policy = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-release-policy",
    minimumStableIntervalSeconds: 86400,
    minimumCanarySoakSeconds: 3600,
    productPathPrefixes: ["packages/"],
    requiredCanaries: [
      { ...value.canary, allowedAttestors: ["github-actions[bot]"] },
    ],
  };
  const fetchImpl = async (url) => {
    const endpoint = new URL(url).pathname + new URL(url).search;
    const prefix = `/repos/${repository}`;
    const responses = {
      [`${prefix}/releases/tags/v4.1.1-alpha.0`]: {
        published_at: "2026-09-11T11:00:00Z",
      },
      [`${prefix}/releases?per_page=100`]: [
        { tag_name: "v4.0.9", published_at: "2026-09-09T11:00:00Z" },
      ],
      [`${prefix}/git/ref/tags/v4.1.1-alpha.0`]: {
        object: { type: "commit", sha: candidateSha },
      },
      [`${prefix}/compare/v4.0.9...v4.1.1-alpha.0`]: {
        files: [{ filename: "packages/core/repair.js" }],
      },
      [`${prefix}/commits/${candidateSha}/statuses?per_page=100`]: [
        value.status,
      ],
      [`${prefix}/actions/runs/42`]: value.run,
      [`${prefix}/actions/workflows/7`]: value.workflow,
      [`${prefix}/actions/runs/42/artifacts?per_page=100`]: {
        artifacts: [
          {
            id: 91,
            name: `buildchain-summary-${value.run.head_sha}`,
            expired: false,
            size_in_bytes: bytes.length,
            digest: digest(bytes),
          },
        ],
      },
    };
    if (endpoint === `${prefix}/actions/artifacts/91/zip`)
      return new Response(bytes);
    assert.ok(endpoint in responses, endpoint);
    return Response.json(responses[endpoint]);
  };
  const input = {
    repository,
    channel: "release",
    candidateVersion: "4.1.1-alpha.0",
    policyInput: JSON.stringify(policy),
    impactInput: JSON.stringify({
      summary: "Repair stable qualification",
      surfaceImpacts: [{ id: "release" }],
    }),
    now: "2026-09-11T13:00:00Z",
    fetchImpl,
  };
  const report = await collectStableReleaseGateReport(input);
  assert.equal(report.summary.decision, "allow");
  assert.equal(
    report.checks.find(
      (entry) => entry.id === "stable.canary.buildchain-zero-input",
    ).status,
    "pass",
  );
  await assert.rejects(
    collectStableReleaseGateReport({ ...input, now: "2026-09-11T12:59:59Z" }),
  );
  value.status.creator.login = "untrusted";
  await assert.rejects(collectStableReleaseGateReport(input));
});
