import assert from "node:assert/strict";
import test from "node:test";
import {
  V4_UNIVERSAL_WORKFLOW_REQUEST,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";
import {
  createV4UniversalBackflowPlan,
  upsertV4UniversalBackflow,
} from "../scripts/v4-universal-workflow-backflow.mjs";

const sha = (value) => value.repeat(40);
const root = (value) => `sha256:${value.repeat(64)}`;

function request() {
  return {
    schema: V4_UNIVERSAL_WORKFLOW_REQUEST,
    mode: "train",
    candidate: {
      repository: "kungfu-systems/buildchain",
      discoveryRef: "train/v4/v4.0/universal-reusable-workflow-bootstrap",
      expectedSha: sha("1"),
      admissionRoot: root("a"),
      reviewPullRequest: 3320,
    },
    consumer: {
      repository: "kungfu-systems/taolu",
      workflow: ".github/workflows/release.yml",
      sourceSha: sha("2"),
    },
    capability: {
      id: "release-candidate-promote",
      contractRoots: [root("b")],
      permissions: { contents: "write" },
    },
    payload: {
      schema: "kungfu-buildchain-v4-universal-release-promotion/v1",
      inputs: {
        channel: "alpha",
        "dry-run": false,
        "target-ref": "alpha/v4/v4.0",
        "target-sha": sha("2"),
      },
    },
  };
}

function receipt(requestValue = request()) {
  return {
    schema: "kungfu-buildchain-v4-universal-workflow-terminal-receipt/v1",
    status: "succeeded",
    requestRoot: v4UniversalWorkflowRequestRoot(requestValue),
    admissionRoot: root("a"),
    discoveryRoot: root("c"),
    reviewRoot: root("d"),
    consumerRoot: root("e"),
    capabilityRoot: root("f"),
    runtime: {
      repository: "kungfu-systems/buildchain",
      sha: sha("1"),
    },
    resultRoot: root("1"),
    receiptRoot: root("2"),
  };
}

test("successful Train delivery binds one exact protected backflow PR", () => {
  const plan = createV4UniversalBackflowPlan({
    request: request(),
    receipt: receipt(),
  });
  assert.equal(plan.pullRequest, 3320);
  assert.equal(plan.trainSha, sha("1"));
  assert.match(plan.backflowRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(
    plan.body,
    /does not designate the Train candidate as a Buildchain release/u,
  );
});

test("failed or non-Train deliveries cannot claim backflow", () => {
  const failed = receipt();
  failed.status = "failed";
  assert.throws(() =>
    createV4UniversalBackflowPlan({ request: request(), receipt: failed }),
  );
  const exact = request();
  exact.mode = "exact";
  exact.candidate.discoveryRef = sha("1");
  assert.throws(() =>
    createV4UniversalBackflowPlan({ request: exact, receipt: receipt(exact) }),
  );
  const dryRun = request();
  dryRun.payload.inputs["dry-run"] = true;
  assert.throws(() =>
    createV4UniversalBackflowPlan({
      request: dryRun,
      receipt: receipt(dryRun),
    }),
  );
});

test("conformance and dry-run successes skip backflow without provider access", async () => {
  for (const requestValue of [
    (() => {
      const value = request();
      value.payload.inputs["dry-run"] = true;
      return value;
    })(),
    (() => {
      const value = request();
      value.capability.id = "bootstrap-conformance";
      value.payload = {
        schema: "kungfu-buildchain-v4-universal-bootstrap-conformance/v1",
        expectedGovernedWorkflowCount: 40,
      };
      return value;
    })(),
  ]) {
    const result = await upsertV4UniversalBackflow({
      request: requestValue,
      receipt: receipt(requestValue),
      token: "",
      fetchImpl: async () => assert.fail("backflow must not access GitHub"),
    });
    assert.equal(result.action, "skipped");
    assert.equal(result.backflowRoot, "");
  }
});

test("the coordinator updates the exact existing backflow receipt", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const value = url.includes("/pulls/")
      ? {
          state: "open",
          base: { ref: "dev/v4/v4.0" },
          head: {
            sha: sha("1"),
            repo: { full_name: "kungfu-systems/buildchain" },
          },
        }
      : url.includes("/issues/3320/comments?")
        ? [
            {
              id: 7,
              body: `<!-- buildchain-universal-backflow:${sha("1")} --> old`,
            },
          ]
        : {
            html_url:
              "https://github.com/kungfu-systems/buildchain/pull/3320#issuecomment-7",
          };
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  const result = await upsertV4UniversalBackflow({
    request: request(),
    receipt: receipt(),
    token: "test-token",
    fetchImpl,
  });
  assert.equal(result.action, "updated");
  assert.equal(calls.at(-1).options.method, "PATCH");
});
