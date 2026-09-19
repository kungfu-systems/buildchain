import assert from "node:assert/strict";
import test from "node:test";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";
import { normalizePromotionRequest } from "../packages/core/release/promotion-request.js";
import { normalInputs, recoveryInputs } from "../packages/core/consumer/contract/entries.js";

const promotion = readWorkflow(".github/workflows/buildchain.yml");
const recovery = readWorkflow(".github/workflows/buildchain-recover.yml");

function renderInputs(workflow, inputs) {
  const context = JSON.parse(JSON.stringify({ inputs }), data.reviver);
  return Object.fromEntries(Object.entries(workflow.jobs.buildchain.with || {}).map(([key, value]) => [
    key,
    value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/gu, (_, expression) => {
      const parsed = new Parser(new Lexer(expression).lex().tokens, ["inputs"], []).parse();
      return new Evaluator(parsed, context).evaluate().coerceString();
    }),
  ]));
}

test("automatic delivery needs no dispatch inputs or consumer-rendered publication request", () => {
  assert.equal(promotion.on.workflow_dispatch, undefined);
  const rendered = renderInputs(promotion, null);
  assert.deepEqual(normalInputs(rendered), { configPath: ".buildchain/buildchain.toml" });
  assert.deepEqual(Object.keys(rendered), []);
});

test("recovery expressions preserve the exact attempt and optional repair selector", () => {
  const attempt = `attempt-${"a".repeat(64)}`;
  for (const runtimeRef of ["", "b".repeat(40), "train/v4/v4.1/repair"]) {
    const rendered = renderInputs(recovery, { attempt, "runtime-ref": runtimeRef });
    assert.deepEqual(recoveryInputs(rendered), { attempt, runtimeRef });
  }
  const omitted = renderInputs(recovery, { attempt });
  assert.deepEqual(recoveryInputs(omitted), { attempt, runtimeRef: "" });
});

test("consumer recovery cannot override source, candidate, payload or provider effects", () => {
  const attempt = `attempt-${"a".repeat(64)}`;
  for (const key of ["target-sha", "request-json", "artifact-patterns", "resume-candidate-run-id", "dry-run", "publish-transaction-override"]) {
    assert.throws(() => recoveryInputs({ attempt, [key]: "override" }), /inputs/u);
    assert.equal(recovery.on.workflow_dispatch.inputs[key], undefined);
  }
  for (const invalid of ["", "1234", `${attempt}\nforged=value`])
    assert.throws(() => recoveryInputs(renderInputs(recovery, { attempt: invalid })), /inputs.attempt/u);
});

test("retained promotion contract rejects null and incorrectly typed recovery fields", () => {
  for (const value of [null, 12345, false])
    assert.throws(() => normalizePromotionRequest({
      schema: "buildchain.promotion-request/v1",
      "resume-candidate-run-id": value,
    }), /resume-candidate-run-id must be string/);
});
