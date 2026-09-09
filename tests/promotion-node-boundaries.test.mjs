import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { run as intent } from "../packages/core/release/nodes/promotion-intent.mjs";
import { run as recover } from "../packages/core/release/nodes/promotion-recovery.mjs";
import { verify } from "../packages/core/runtime/nodes/provider-closure.mjs";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha = "a".repeat(40),
  next = "b".repeat(40),
  tree = "c".repeat(40);
const context = {
  repo: { owner: "example", repo: "consumer" },
  sha,
  ref: "refs/heads/alpha/v4/v4.1",
};
const read = (file) =>
  YAML.parse(fs.readFileSync(path.join(root, file), "utf8"));
function routeFixture({
  observed = sha,
  comparison = "identical",
  date = "2026-09-09T00:00:00Z",
} = {}) {
  const calls = [],
    outputs = {};
  return {
    calls,
    outputs,
    args: {
      context,
      env: { INPUT_CHANNEL: "alpha", BUILDCHAIN_RUNTIME_ROOT: root },
      core: { setOutput: (key, value) => (outputs[key] = value) },
      github: {
        rest: {
          git: {
            getRef: async (args) => {
              calls.push(args);
              return { data: { object: { sha: observed } } };
            },
            getCommit: async (args) => {
              calls.push(args);
              return { data: { committer: { date } } };
            },
          },
          repos: {
            compareCommitsWithBasehead: async (args) => {
              calls.push(args);
              return { data: { status: comparison } };
            },
          },
        },
      },
    },
  };
}
test("qualification queries the exact source and plans a fresh or superseded route with the domain core", async () => {
  const fresh = routeFixture();
  await intent(fresh.args);
  assert.equal(fresh.outputs.action, "promote");
  assert.equal(fresh.outputs["requested-sha"], sha);
  assert.equal(fresh.outputs["source-timestamp"], "2026-09-09T00:00:00.000Z");
  assert.equal(fresh.calls[0].ref, "heads/alpha/v4/v4.1");
  assert.equal(fresh.calls[1].commit_sha, sha);
  const stale = routeFixture({ observed: next, comparison: "ahead" });
  await intent(stale.args);
  assert.equal(stale.outputs.action, "noop");
  assert.equal(stale.calls[2].basehead, `${sha}...${next}`);
});
test("qualification cannot expose promotable outputs for divergence or missing provider timestamp", async () => {
  for (const changes of [
    { observed: next, comparison: "diverged" },
    { date: undefined },
  ]) {
    const fixture = routeFixture(changes);
    if ("date" in changes)
      fixture.args.github.rest.git.getCommit = async () => ({ data: {} });
    await assert.rejects(() => intent(fixture.args));
    assert.deepEqual(fixture.outputs, {});
  }
});
function recoveryFixture(status = 404, explicit = false) {
  const calls = [],
    outputs = {};
  return {
    calls,
    outputs,
    args: {
      context,
      env: {
        BUILDCHAIN_RUNTIME_ROOT: root,
        BUILDCHAIN_REQUESTED_SHA: sha,
        BUILDCHAIN_CANDIDATE_VERSION: "4.1.0-alpha.0",
        BUILDCHAIN_EXPLICIT_RESUME: String(explicit),
      },
      core: { setOutput: (key, value) => (outputs[key] = value) },
      github: {
        paginate: async (fn, args) => {
          calls.push(args);
          return [];
        },
        rest: {
          git: {
            listMatchingRefs() {},
            getRef: async (args) => {
              calls.push(args);
              throw Object.assign(new Error("provider read failed"), {
                status,
              });
            },
          },
        },
      },
    },
  };
}
test("recovery preserves explicit transaction identity and never treats a denied provider read as absent", async () => {
  const explicit = recoveryFixture(403, true);
  await recover(explicit.args);
  assert.equal(explicit.outputs.version, "4.1.0-alpha.0");
  assert.deepEqual(explicit.calls, []);
  const denied = recoveryFixture(403);
  await assert.rejects(() => recover(denied.args), { status: 403 });
  assert.deepEqual(denied.outputs, {});
  const absent = recoveryFixture(404);
  await assert.rejects(() => recover(absent.args), {
    code: "recovery-tag-missing",
  });
  assert.deepEqual(absent.outputs, {});
});
test("provider closure rejects mutable identities and tree drift before exposing dependencies", () => {
  const env = { RUNTIME_SHA: sha, RUNTIME_TREE: tree },
    calls = [];
  verify(env, (command, args) => {
    calls.push([command, args]);
    return args.at(-1) === "HEAD" ? sha : tree;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].at(-1), "HEAD^{tree}");
  assert.throws(
    () =>
      verify({ ...env, RUNTIME_SHA: "v4-alpha" }, () => {
        throw Error("must not query");
      }),
    /40-hex/,
  );
  assert.throws(
    () =>
      verify(env, (_command, args) => (args.at(-1) === "HEAD" ? sha : next)),
    /does not match/,
  );
  const action = read("actions/runtime/provider-closure/action.yml");
  const verification = action.runs.steps.findIndex(
    (step) => step.name === "Verify the privileged executable closure",
  );
  const install = action.runs.steps.findIndex((step) =>
    step.run?.includes("pnpm@11.7.0 install"),
  );
  assert.ok(verification >= 0 && verification < install);
  assert.match(
    action.runs.steps[install].run,
    /--frozen-lockfile --ignore-scripts/,
  );
});
test("promotion jobs retain authority separation, runtime selector precedence, and always-run evidence tails", () => {
  const workflow = read(".github/workflows/.release-promote.yml");
  assert.match(
    workflow.jobs.qualify.steps.at(-1).with["runtime-ref"],
    /fromJSON\(inputs.request-json\).promotion-runtime-sha/,
  );
  assert.deepEqual(workflow.jobs.settle.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.match(workflow.jobs.apply.if, /!fromJSON\(inputs.request-json\).dry-run/);
  const apply = read("actions/release/promote-apply/action.yml");
  const interrupted = apply.runs.steps.find(
    (s) => s.id === "interrupted-provider",
  );
  assert.equal(interrupted["continue-on-error"], true);
  assert.match(
    apply.runs.steps.find((s) => s.id === "resume").if,
    /steps.interrupted-provider.outcome == 'failure'/,
  );
  assert.match(apply.runs.steps.at(-1).if, /always\(\)/);
  assert.match(
    apply.runs.steps.find((s) => s.id === "publication-settlement").if,
    /always\(\)/,
  );
  const qualify = read("actions/release/promote-qualify/action.yml");
  const prepare = qualify.runs.steps.findIndex((s) =>
    s.uses?.endsWith("/actions/runtime/prepare"),
  );
  assert.ok(prepare < qualify.runs.steps.findIndex((s) => s.id === "intent"));
  assert.equal(qualify.runs.steps[prepare].if, undefined);
});
