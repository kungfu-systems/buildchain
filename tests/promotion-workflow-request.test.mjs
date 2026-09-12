import assert from "node:assert/strict";
import test from "node:test";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";
import { normalizePromotionRequest } from "../packages/core/release/promotion-request.js";

const promotion = readWorkflow(".github/workflows/self-release-promote.yml");
const recovery = readWorkflow(
  ".github/workflows/self-ops-promotion-recovery.yml",
);
const sourceSha = "a".repeat(40),
  workflowSha = "b".repeat(40),
  runtimeSha = "c".repeat(40);
const recoveryFields = [
  "resume-candidate-repository",
  "resume-candidate-run-id",
  "resume-expected-source-tree",
  "resume-expected-candidate-root",
  "resume-transaction-id",
];

function renderRequest(workflow, job, context) {
  const values = JSON.parse(
    JSON.stringify({ inputs: null, vars: {}, ...context }),
    data.reviver,
  );
  const rendered = workflow.jobs[job].with["request-json"].replace(
    /\$\{\{\s*([\s\S]*?)\s*\}\}/gu,
    (_, expression) => {
      const tokens = new Lexer(expression).lex().tokens;
      const parsed = new Parser(
        tokens,
        ["github", "inputs", "vars"],
        [],
      ).parse();
      return new Evaluator(parsed, values).evaluate().coerceString();
    },
  );
  return JSON.parse(rendered);
}

function manualContext(workflow, inputs) {
  const defaults = Object.fromEntries(
    Object.entries(workflow.on.workflow_dispatch.inputs)
      .filter(([, input]) => Object.hasOwn(input, "default"))
      .map(([key, input]) => [key, input.default]),
  );
  return {
    github: { sha: workflowSha, event: {}, event_name: "workflow_dispatch" },
    inputs: { ...defaults, ...inputs },
    vars: {},
  };
}

test("automatic promotion renders a fully typed request without a manual inputs context", () => {
  for (const branch of ["alpha/v4/v4.1", "release/v4/v4.1"]) {
    const request = renderRequest(promotion, "promote", {
      github: {
        sha: workflowSha,
        event_name: "workflow_run",
        event: { workflow_run: { head_sha: sourceSha, head_branch: branch } },
      },
      vars: {},
    });
    const normalized = normalizePromotionRequest(request);
    assert.equal(normalized["target-sha"], sourceSha);
    assert.equal(normalized["target-ref"], branch);
    for (const field of recoveryFields) assert.equal(request[field], "", field);
    assert.equal(request["buildchain-ref"], undefined);
    assert.equal(request["standalone-binary-distribution"], true);
    assert.equal(request["publish-transaction-override"], false);
    assert.equal(request["dry-run"], false);
    assert.equal(request["trusted-publishing"], true);
  }
});

test("candidate recovery preserves explicit identities and typed publication flags", () => {
  const inputs = {
    sha: sourceSha,
    "target-ref": "alpha/v4/v4.1",
    "dry-run": "false",
    "resume-candidate-repository": "fixture/source",
    "resume-candidate-run-id": "12345",
    "resume-expected-source-tree": "d".repeat(40),
    "resume-expected-candidate-root": `sha256:${"e".repeat(64)}`,
    "resume-expected-candidate-runtime-sha": runtimeSha,
    "resume-buildchain-runtime-sha": runtimeSha,
    "resume-buildchain-runtime-ref": "train/v4/v4.1/candidate",
    "resume-transaction-id": "transaction-123",
  };
  const request = renderRequest(
    promotion,
    "promote",
    manualContext(promotion, inputs),
  );
  normalizePromotionRequest(request);
  for (const field of recoveryFields)
    assert.equal(request[field], inputs[field], field);
  assert.equal(request["target-sha"], sourceSha);
  assert.equal(request["buildchain-ref"], undefined);
  assert.equal(request["standalone-binary-distribution"], false);
  assert.equal(request["github-release-payload-patterns"], "*.tgz");
  assert.equal(request["publish-transaction-override"], true);
  assert.equal(request["dry-run"], false);
});

test("durable recovery retains the exact workflow runtime and empty optional candidate fields", () => {
  const request = renderRequest(
    promotion,
    "promote",
    manualContext(promotion, {
      sha: sourceSha,
      "recover-durable-transaction": true,
      "dry-run": "false",
    }),
  );
  normalizePromotionRequest(request);
  assert.equal(request["buildchain-ref"], undefined);
  assert.equal(request["target-sha"], sourceSha);
  assert.equal(request["publish-transaction-override"], true);
  for (const field of recoveryFields) assert.equal(request[field], "", field);
});

test("standalone recovery renders omitted optional inputs and preserves evidence JSON", () => {
  for (const target of ["alpha/v4/v4.1", "release/v4/v4.1"]) {
    const inputs = {
      sha: sourceSha,
      "target-ref": target,
      "resume-buildchain-runtime-ref": "v4-alpha",
      "resume-buildchain-runtime-sha": runtimeSha,
    };
    const request = renderRequest(
      recovery,
      "resume",
      manualContext(recovery, inputs),
    );
    normalizePromotionRequest(request);
    assert.equal(request["dry-run"], true);
    assert.equal(request["resume-candidate-run-id"], "");
    assert.equal(
      request["release-passport-v4-runtime-resume-evidence-json"],
      "",
    );
    assert.equal(request["buildchain-contract-lock-path"], undefined);
    const evidence = JSON.stringify({
      title: 'quoted "value"',
      lines: "one\ntwo",
    });
    const explicit = renderRequest(
      recovery,
      "resume",
      manualContext(recovery, {
        ...inputs,
        "dry-run": false,
        "release-passport-v4-runtime-resume-evidence-json": evidence,
      }),
    );
    normalizePromotionRequest(explicit);
    assert.equal(
      explicit["release-passport-v4-runtime-resume-evidence-json"],
      evidence,
    );
    assert.equal(explicit["dry-run"], false);
  }
});

test("promotion contract still rejects null and incorrectly typed recovery fields", () => {
  for (const value of [null, 12345, false])
    assert.throws(
      () =>
        normalizePromotionRequest({
          schema: "buildchain.promotion-request/v1",
          "resume-candidate-run-id": value,
        }),
      /resume-candidate-run-id must be string/,
    );
});

function jobEnabled(job, context) {
  const functions = [
    {
      name: "always",
      minArgs: 0,
      maxArgs: 0,
      call: () => new data.BooleanData(true),
    },
  ];
  const expression = promotion.jobs[job].if.trim().slice(3, -2);
  const values = { needs: {}, ...context };
  const parsed = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(values),
    functions,
  ).parse();
  return (
    new Evaluator(
      parsed,
      JSON.parse(JSON.stringify(values), data.reviver),
      new Map(functions.map((entry) => [entry.name, entry])),
    )
      .evaluate()
      .coerceString() === "true"
  );
}

test("exact manual alpha source starts a fresh admitted publication without partial-release recovery", () => {
  const context = manualContext(promotion, {
    sha: sourceSha,
    "dry-run": "false",
    "runtime-ref": runtimeSha,
  });
  assert.equal(jobEnabled("promote", context), true);
  assert.equal(jobEnabled("reject-manual-apply", context), false);
  const request = normalizePromotionRequest(
    renderRequest(promotion, "promote", context),
  );
  assert.equal(request["target-sha"], sourceSha);
  assert.equal(request["publish-transaction-override"], false);
  assert.equal(request["publication-auto-admission"], true);
  assert.equal(request["standalone-binary-distribution"], true);
  assert.equal(request["dry-run"], false);
});

test("manual apply rejects a missing source and does not admit stable publication", () => {
  for (const inputs of [
    { "dry-run": "false" },
    { "dry-run": "false", sha: sourceSha, "target-ref": "release/v4/v4.1" },
  ]) {
    const context = manualContext(promotion, inputs);
    assert.equal(jobEnabled("promote", context), false);
    assert.equal(jobEnabled("reject-manual-apply", context), true);
  }
  const recoveryContext = manualContext(promotion, {
    sha: sourceSha,
    "dry-run": "false",
    "recover-durable-transaction": true,
  });
  assert.equal(jobEnabled("promote", recoveryContext), true);
  assert.equal(jobEnabled("reject-manual-apply", recoveryContext), false);
  assert.equal(
    renderRequest(promotion, "promote", recoveryContext)[
      "publish-transaction-override"
    ],
    true,
  );
});
