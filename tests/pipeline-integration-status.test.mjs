import test from "node:test";
import assert from "node:assert/strict";
import { publishIntegratedPipelineStatus } from "../packages/core/workflow/pipeline/integration-status.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture() {
  const repository = "example/consumer",
    source = "1".repeat(40),
    merge = "2".repeat(40);
  const current = {
    intent: { source: { pullRequest: 23, targetBranch: "dev/v4/v4.1" } },
    generation: { source: { commit: source } },
  };
  const pr = {
    state: "open",
    merged: false,
    merge_commit_sha: merge,
    head: { sha: source, repo: { full_name: repository } },
    base: {
      ref: current.intent.source.targetBranch,
      repo: { full_name: repository },
    },
  };
  const body = {
    repository,
    pullRequest: 23,
    sourceHead: source,
    branch: pr.base.ref,
    mergeCommit: merge,
    build: { source: { repository, commit: merge }, outcome: "success" },
    run: {
      id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      event: "merge_group",
      head_sha: merge,
    },
  };
  const proof = { ...body, root: recordDigest(body) },
    effects = [];
  const providerRun = {
    ...proof.run,
    path: ".github/workflows/buildchain.yml",
  };
  let elapsed = 0;
  const ports = {
    repository,
    now: () => elapsed,
    request: async (url) =>
      url.includes("/actions/runs?")
        ? {
            total_count: 1,
            workflow_runs: [providerRun],
          }
        : structuredClone(pr),
    integration: { observe: async () => structuredClone(proof) },
    queue: async () => ({
      enabled: true,
      entries: [{ pullRequestNumber: 23, pullRequestHeadSha: source }],
    }),
    pause: async (ms) => {
      elapsed += ms;
      pr.merged = true;
    },
    status: async (url, options) => effects.push({ url, ...options }),
  };
  return { current, pr, proof, ports, effects, providerRun };
}

test("a merged PR still requires its real queue workflow to finish successfully", async () => {
  const f = fixture();
  f.pr.merged = true;
  f.providerRun.status = "in_progress";
  let polls = 0;
  f.ports.pause = async () => {
    polls++;
    f.providerRun.status = "completed";
  };
  await publishIntegratedPipelineStatus(f.current, f.ports);
  assert.equal(polls, 1);
  assert.equal(f.effects.length, 1);
  const failed = fixture();
  failed.pr.merged = true;
  failed.providerRun.conclusion = "failure";
  await assert.rejects(
    publishIntegratedPipelineStatus(failed.current, failed.ports),
    /no successful queue workflow/u,
  );
  assert.equal(failed.effects.length, 0);
});

test("landing projects the actual merged commit after successful queue integration", async () => {
  const f = fixture();
  await publishIntegratedPipelineStatus(f.current, f.ports);
  assert.equal(f.effects.length, 1);
  assert.equal(
    f.effects[0].url,
    `/repos/example/consumer/statuses/${f.proof.mergeCommit}`,
  );
  assert.equal(f.effects[0].body.context, "check");
  assert.equal(f.effects[0].body.state, "success");
  assert.match(f.effects[0].body.target_url, /runs\/42\/attempts\/1$/u);
});

test("queue removal can precede the converged merged PR readback", async () => {
  for (const state of ["open", "closed"]) {
    const f = fixture();
    let elapsed = 0;
    f.pr.state = state;
    f.ports.now = () => elapsed;
    f.ports.queue = async () => ({ enabled: true, entries: [] });
    f.ports.pause = async (ms) => {
      elapsed += ms;
      assert.equal(f.effects.length, 0);
      if (elapsed >= 20_000) f.pr.merged = true;
    };
    await publishIntegratedPipelineStatus(f.current, f.ports);
    assert.equal(elapsed, 20_000);
    assert.equal(f.effects.length, 1);
  }
});

test("an absent queue entry has a bounded convergence window and no success without merge", async () => {
  const f = fixture();
  let elapsed = 0;
  f.ports.now = () => elapsed;
  f.ports.pause = async (ms) => {
    elapsed += ms;
  };
  f.ports.queue = async () => ({ enabled: true, entries: [] });
  await assert.rejects(
    publishIntegratedPipelineStatus(f.current, f.ports),
    /left its protected merge queue/u,
  );
  assert.equal(elapsed, 30_000);
  assert.equal(f.effects.length, 0);
});

test("source drift during convergence cannot publish the old integration proof", async () => {
  const f = fixture();
  let elapsed = 0;
  f.ports.now = () => elapsed;
  f.ports.queue = async () => ({ enabled: true, entries: [] });
  f.ports.pause = async (ms) => {
    elapsed += ms;
    f.pr.head.sha = "3".repeat(40);
    f.pr.merged = true;
  };
  await assert.rejects(
    publishIntegratedPipelineStatus(f.current, f.ports),
    /exact admitted PR source/u,
  );
  assert.equal(f.effects.length, 0);
});

test("an exact queue reappearance resets only its absence window", async () => {
  const f = fixture();
  let elapsed = 0;
  const present = f.ports.queue;
  f.ports.now = () => elapsed;
  f.ports.queue = async () =>
    elapsed === 10_000 ? present() : { enabled: true, entries: [] };
  f.ports.pause = async (ms) => {
    elapsed += ms;
    if (elapsed === 40_000) f.pr.merged = true;
  };
  await publishIntegratedPipelineStatus(f.current, f.ports);
  assert.equal(elapsed, 40_000);
  assert.equal(f.effects.length, 1);
});

test("source changes, queue removal, closed PR and bounded queue expiry never publish success", async () => {
  for (const change of [
    (f) => {
      f.pr.head.sha = "3".repeat(40);
    },
    (f) => {
      f.pr.base.ref = "dev/v4/v4.2";
    },
    (f) => {
      f.pr.state = "closed";
    },
    (f) => {
      f.ports.queue = async () => ({ enabled: true, entries: [] });
    },
    (f) => {
      let ticks = 0;
      f.ports.now = () => ticks++ * 120 * 60 * 1000;
    },
  ]) {
    const f = fixture();
    let elapsed = 0;
    f.ports.now = () => elapsed;
    f.ports.pause = async (ms) => {
      elapsed += ms;
    };
    change(f);
    await assert.rejects(publishIntegratedPipelineStatus(f.current, f.ports));
    assert.equal(f.effects.length, 0);
  }
});

test("a removal racing successful merge is reread, while failed or mismatched proof is rejected", async () => {
  const race = fixture();
  race.ports.queue = async () => {
    race.pr.merged = true;
    return { enabled: true, entries: [] };
  };
  await publishIntegratedPipelineStatus(race.current, race.ports);
  assert.equal(race.effects.length, 1);
  for (const change of [
    (p) => {
      p.build.outcome = "failure";
    },
    (p) => {
      p.run.status = "in_progress";
    },
    (p) => {
      p.run.event = "push";
    },
    (p) => {
      p.build.source.commit = "4".repeat(40);
    },
    (p) => {
      p.sourceHead = "5".repeat(40);
    },
  ]) {
    const f = fixture();
    f.pr.merged = true;
    change(f.proof);
    const { root, ...body } = f.proof;
    f.proof.root = recordDigest(body);
    await assert.rejects(
      publishIntegratedPipelineStatus(f.current, f.ports),
      /verified queue result/u,
    );
    assert.equal(f.effects.length, 0);
  }
});

test("provider integration and status failures remain visible", async () => {
  for (const phase of ["integration", "status"]) {
    const f = fixture();
    f.pr.merged = true;
    const fail = async () => {
      throw new Error("provider unavailable");
    };
    if (phase === "integration") f.ports.integration.observe = fail;
    else f.ports.status = fail;
    await assert.rejects(
      publishIntegratedPipelineStatus(f.current, f.ports),
      /provider unavailable/u,
    );
  }
});
