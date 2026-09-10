import assert from "node:assert/strict";
import fs from "node:fs";
import { EOL } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { classifyProductPublication } from "../packages/core/release/promotion/product-state.js";
import { productPublicationReader } from "../packages/core/providers/github/product-publication.js";
async function run({ env, github, context, core }) {
  const result = await classifyProductPublication(
    {
      requestedSha: env.BUILDCHAIN_TARGET_SHA,
      targetRef: env.BUILDCHAIN_TARGET_REF,
    },
    productPublicationReader(
      github,
      `${context.repo.owner}/${context.repo.repo}`,
    ),
  );
  for (const [key, value] of Object.entries(result)) core.setOutput(key, value);
}
const root = path.resolve(import.meta.dirname, "..");
const sha = "d".repeat(40),
  source = "e".repeat(40),
  tree = "f".repeat(40),
  stateSha = "b".repeat(40);
function fixture({ refs = [], status = "ahead", denied = false } = {}) {
  const calls = [],
    outputs = {};
  const stateRef = (version, index) => ({
    ref: `refs/heads/buildchain/v4-product-state/${source}-${version.replaceAll(".", "-")}`,
    object: { type: "commit", sha: index === 0 ? stateSha : "c".repeat(40) },
  });
  return {
    calls,
    outputs,
    args: {
      env: {
        GITHUB_WORKSPACE: root,
        BUILDCHAIN_TARGET_SHA: sha,
        BUILDCHAIN_TARGET_REF: "alpha/v4/v4.1",
      },
      context: { repo: { owner: "example", repo: "consumer" } },
      core: { setOutput: (k, v) => (outputs[k] = v), info: () => {} },
      github: {
        paginate: async (_fn, args) => {
          calls.push(args);
          return refs.map(stateRef);
        },
        rest: {
          git: {
            listMatchingRefs() {},
            getCommit: async (args) => {
              calls.push(args);
              return {
                data: {
                  sha: args.commit_sha,
                  tree: { sha: tree },
                  parents: [{ sha: source }],
                },
              };
            },
            getRef: async (args) => {
              calls.push(args);
              if (denied)
                throw Object.assign(new Error("denied"), { status: 403 });
              return {
                data: {
                  ref: `refs/${args.ref}`,
                  object: { type: "commit", sha: source },
                },
              };
            },
          },
          repos: {
            compareCommitsWithBasehead: async (args) => {
              calls.push(args);
              return { data: { status } };
            },
          },
        },
      },
    },
  };
}
test("publication classifier detects one exact finalized state without admitting a duplicate version", async () => {
  const fresh = fixture();
  await run(fresh.args);
  assert.deepEqual(fresh.outputs, {
    action: "promote",
    "finalized-version": "",
  });
  const finalized = fixture({ refs: ["4.1.0-alpha.0"] });
  await run(finalized.args);
  assert.deepEqual(finalized.outputs, {
    action: "noop",
    "finalized-version": "4.1.0-alpha.0",
  });
  assert.ok(finalized.calls.some((x) => x.basehead === `${stateSha}...${sha}`));
  const ambiguous = fixture({ refs: ["4.1.0-alpha.0", "4.1.0-alpha.1"] });
  await assert.rejects(() => run(ambiguous.args), {
    code: "finalization-state-ambiguous",
  });
  assert.deepEqual(ambiguous.outputs, {});
  const denied = fixture({ refs: ["4.1.0-alpha.0"], denied: true });
  await assert.rejects(() => run(denied.args), { status: 403 });
  assert.deepEqual(denied.outputs, {});
});
test("request rejection always fails and treats its reason as data", () => {
  const action = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/workflow/admission/reject/action.yml"),
      "utf8",
    ),
  );
  const reason = "Request rejected: $(printf unexpected-execution)";
  const result = spawnSync(
    process.execPath,
    [path.join(root, "actions/workflow/admission/reject", action.runs.main)],
    {
      env: { ...process.env, INPUT_REASON: reason },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.error?.message);
  assert.equal(result.stdout, `::error::${reason}${EOL}`);
});
test("all rejection nodes retain their workflow-owned conditions and scoped permissions", () => {
  for (const name of ["daily", "weekly", "monthly"]) {
    const workflow = YAML.parse(
      fs.readFileSync(
        path.join(root, `.github/workflows/self-ops-housekeeping-${name}.yml`),
        "utf8",
      ),
    );
    const job = workflow.jobs["invalid-apply-gate"];
    assert.match(job.if, /!inputs.apply-enabled/);
    assert.deepEqual(job.permissions, {});
    assert.equal(
      job.steps.at(-1).uses,
      "./.buildchain/workflow-shell/actions/workflow/admission/reject",
    );
  }
  const workflow = YAML.parse(
    fs.readFileSync(
      path.join(root, ".github/workflows/self-release-promote.yml"),
      "utf8",
    ),
  );
  for (const id of [
    "reject-manual-apply",
    "reject-invalid-durable-recovery",
    "reject-invalid-candidate-recovery",
  ]) {
    const job = workflow.jobs[id];
    assert.match(job.if, /github.event_name == 'workflow_dispatch'/);
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.equal(
      job.steps.at(-1).uses,
      "./.buildchain/workflow-shell/actions/workflow/admission/reject",
    );
  }
});
