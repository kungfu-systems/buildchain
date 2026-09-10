import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { qualifyPromotionSource } from "../packages/core/release/promotion/source-intent.js";
import { recoverProductPublicationVersion } from "../packages/core/release/promotion/product-state.js";
import { productPublicationReader } from "../packages/core/providers/github/product-publication.js";
import {
  verify,
  activateProviderClosure,
} from "../packages/core/runtime/provider-closure.js";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha = "a".repeat(40),
  next = "b".repeat(40),
  tree = "c".repeat(40);
const context = {
  repo: { owner: "example", repo: "consumer" },
  sha,
  ref: "refs/heads/alpha/v4/v4.1",
};
async function intent({ context, github, core, env }) {
  const result = await qualifyPromotionSource(
    {
      requestedSha: context.sha,
      targetRef: context.ref.replace(/^refs\/heads\//, ""),
      requestedChannel: env.INPUT_CHANNEL,
    },
    productPublicationReader(
      github,
      `${context.repo.owner}/${context.repo.repo}`,
    ),
  );
  for (const [key, value] of Object.entries(result)) core.setOutput(key, value);
}
async function recover({ context, github, core, env }) {
  const version = await recoverProductPublicationVersion(
    {
      requestedSha: env.BUILDCHAIN_REQUESTED_SHA,
      candidateVersion: env.BUILDCHAIN_CANDIDATE_VERSION,
      explicitResume: env.BUILDCHAIN_EXPLICIT_RESUME === "true",
    },
    productPublicationReader(
      github,
      `${context.repo.owner}/${context.repo.repo}`,
    ),
  );
  core.setOutput("version", version);
}
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
  const action = read("actions/runtime/closure/prepare-provider/action.yml");
  assert.ok(
    action.runs.steps
      .at(-1)
      .uses.endsWith("/actions/runtime/closure/activate-provider"),
  );
  for (const failure of ["verify", "install", null]) {
    const calls = [];
    const ports = Object.fromEntries(
      ["verify", "install", "expose"].map((name) => [
        name,
        (value) => {
          calls.push(name);
          if (name === failure) throw new Error(name);
          if (name === "install")
            assert.deepEqual(value, {
              directory: ".buildchain/runtime",
              production: false,
              ignoreScripts: true,
            });
        },
      ]),
    );
    if (failure)
      assert.throws(
        () => activateProviderClosure({ sha, tree }, ports),
        new RegExp(failure),
      );
    else activateProviderClosure({ sha, tree }, ports);
    assert.deepEqual(
      calls,
      failure === "verify"
        ? ["verify"]
        : failure === "install"
          ? ["verify", "install"]
          : ["verify", "install", "expose"],
    );
  }
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
  assert.match(
    workflow.jobs.apply.if,
    /!fromJSON\(inputs.request-json\).dry-run/,
  );
  const apply = read("actions/release/promotion/apply/action.yml");
  const interrupted = apply.runs.steps.find((s) => s.id === "provider");
  assert.match(
    interrupted["continue-on-error"],
    /provider-failure-after-capability/,
  );
  assert.match(
    apply.runs.steps.find((s) => s.id === "resume").if,
    /steps.provider.outcome == 'failure'/,
  );
  assert.match(apply.runs.steps.at(-1).if, /always\(\)/);
  assert.match(
    apply.runs.steps.find((s) => s.id === "publication-settlement").if,
    /always\(\)/,
  );
  const qualify = read("actions/release/promotion/qualify/action.yml");
  const prepare = qualify.runs.steps.findIndex((s) =>
    s.uses?.endsWith("/actions/runtime/environment/prepare"),
  );
  assert.ok(
    prepare < qualify.runs.steps.findIndex((s) => s.id === "qualification"),
  );
  assert.equal(qualify.runs.steps[prepare].if, undefined);
});
