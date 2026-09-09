import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import {
  createControllerPlan,
  createControllerReceipt,
} from "../packages/core/observability/controller-evidence.js";
import {
  createPaperControllerPlan,
  createPaperControllerReceipt,
} from "../packages/core/paper/publication-controller.js";

const registry = JSON.parse(
  fs.readFileSync("dist/site/controller-registry.json", "utf8"),
);
const descriptor = (id) =>
  registry.controllers.find((entry) => entry.id === id);
const source = { repository: "example/paper", sha: "a".repeat(40) };
const runtime = {
  ref: "v4-alpha",
  sha: "b".repeat(40),
  contractDigest: `sha256:${"c".repeat(64)}`,
};
const evidence = (kind) => ({ kind, digest: `sha256:${"d".repeat(64)}` });
function fixture() {
  const candidatePlan = createControllerPlan({
    descriptor: descriptor("publication-artifact"),
    source,
    runtime,
  });
  const candidateReceipt = createControllerReceipt({
    plan: candidatePlan,
    stages: candidatePlan.expected.stages.map(({ id }) => ({
      id,
      status: "passed",
    })),
    evidence: [
      evidence("publication-manifest"),
      evidence("publication-passport"),
    ],
  });
  const plan = createPaperControllerPlan({
    descriptor: descriptor("paper-release"),
    candidateReceipt,
    source,
    runtime,
    inputs: {},
  });
  return {
    plan,
    candidateReceipt,
    publishOutcome: "success",
    readbackOutcome: "success",
    aggregateOutcome: "success",
    tag: "v1.0.0",
    passport: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-passport",
      product: {
        name: "Paper",
        repository: source.repository,
        mechanism: "mechanism.json",
      },
      release: { tag: "v1.0.0", sourceSha: source.sha },
      artifacts: [{ name: "paper.pdf" }],
      evidence: {
        artifactEvidence: "artifacts.json",
        impact: "impact.json",
        agentIndex: "index.json",
      },
      recovery: {},
    },
    evidence: [evidence("publication-manifest"), evidence("release-passport")],
  };
}

test("Paper controller proves admitted build and completed publication separately", () => {
  const input = fixture(),
    receipt = createPaperControllerReceipt(input);
  assert.equal(receipt.controller.id, "paper-release");
  assert.notEqual(receipt.digest, input.candidateReceipt.digest);
  assert.equal(receipt.qualifying, true);
  assert.equal(receipt.planDigest, input.plan.digest);
  assert.deepEqual(
    receipt.stages.map(({ status }) => status),
    Array(8).fill("passed"),
  );
});
test("Paper publication and readback failures retain nonqualifying controller receipts", () => {
  for (const patch of [
    { publishOutcome: "failure", readbackOutcome: "skipped" },
    { publishOutcome: "cancelled", readbackOutcome: "skipped" },
    { publishOutcome: "", readbackOutcome: "" },
    { readbackOutcome: "failure" },
    { aggregateOutcome: "failure" },
    { evidence: [] },
  ]) {
    const receipt = createPaperControllerReceipt({ ...fixture(), ...patch });
    assert.equal(receipt.qualifying, false, JSON.stringify(patch));
    assert.equal(receipt.kind, "receipt");
  }
});
test("Paper admission rejects a candidate for another source or runtime", () => {
  const { candidateReceipt } = fixture();
  for (const patch of [
    { source: { ...source, sha: "e".repeat(40) } },
    { source: { ...source, repository: "example/other" } },
    { runtime: { ...runtime, sha: "e".repeat(40) } },
    { runtime: { ...runtime, contractDigest: `sha256:${"e".repeat(64)}` } },
  ])
    assert.throws(
      () =>
        createPaperControllerPlan({
          descriptor: descriptor("paper-release"),
          candidateReceipt,
          source,
          runtime,
          inputs: {},
          ...patch,
        }),
      /exact source and runtime/,
    );
});
test("Paper settlement cannot qualify a changed candidate or substituted or absent Passport", () => {
  const input = fixture();
  for (const patch of [
    { candidateReceipt: undefined },
    { candidateReceipt: { ...input.candidateReceipt, status: "failed" } },
    { passport: undefined },
    { passport: {} },
    {
      passport: {
        ...input.passport,
        product: { ...input.passport.product, repository: "example/other" },
      },
    },
    {
      passport: {
        ...input.passport,
        release: { ...input.passport.release, sourceSha: "e".repeat(40) },
      },
    },
    {
      passport: {
        ...input.passport,
        release: { ...input.passport.release, tag: "v2.0.0" },
      },
    },
  ]) {
    const receipt = createPaperControllerReceipt({ ...input, ...patch });
    assert.equal(receipt.qualifying, false);
    assert.equal(receipt.status, "failed");
  }
});
test("Paper API always settles an admitted plan and exposes its own final receipt", () => {
  const workflow = YAML.parse(
    fs.readFileSync(".github/workflows/public-release-paper.yml", "utf8"),
  );
  const settle = workflow.jobs.publish.steps.find(
    (step) => step.id === "settle-publication",
  );
  assert.match(settle.if, /always\(\)/);
  assert.match(
    settle.with["publish-outcome"],
    /steps.publish-candidate.outcome/,
  );
  assert.equal(
    workflow.on.workflow_call.outputs["controller-receipt-json"].value,
    "${{ jobs.publish.outputs.controller-receipt-json }}",
  );
  const action = YAML.parse(
    fs.readFileSync("actions/paper/settle-publication/action.yml", "utf8"),
  );
  assert.match(
    action.runs.steps.find((step) => step.id === "controller-receipt").if,
    /always\(\).*controller-plan-outcome/,
  );
  assert.match(action.runs.steps.at(-1).if, /always\(\)/);
});
