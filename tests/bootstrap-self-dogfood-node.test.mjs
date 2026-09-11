import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import { selfDogfoodReady } from "../packages/core/workflow/dogfood/readiness.js";
import { selfDogfoodCoordinates } from "../packages/core/workflow/dogfood/transactions.js";
const sha = "a".repeat(40);
function readiness() {
  return {
    number: 1,
    candidateSha: sha,
    pullRequest: {
      number: 1,
      state: "open",
      head: { sha, repo: { full_name: "kungfu-systems/buildchain" } },
      base: {
        ref: "dev/v4/v4.1",
        repo: { full_name: "kungfu-systems/buildchain" },
      },
    },
    reviews: [
      {
        id: 1,
        state: "APPROVED",
        commit_id: sha,
        user: { login: "kungfu-origin" },
      },
    ],
    checks: [
      {
        id: 1,
        name: "check",
        head_sha: sha,
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
      },
    ],
  };
}
test("self-dogfood needs latest exact review and GitHub Actions check rather than historical approval", () => {
  const input = readiness();
  assert.equal(selfDogfoodReady(input), true);
  for (const state of ["DISMISSED", "CHANGES_REQUESTED"])
    assert.equal(
      selfDogfoodReady({
        ...input,
        reviews: [...input.reviews, { ...input.reviews[0], id: 2, state }],
      }),
      false,
    );
  for (const update of [
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
  ])
    assert.equal(
      selfDogfoodReady({
        ...input,
        checks: [...input.checks, { ...input.checks[0], id: 2, ...update }],
      }),
      false,
    );
  assert.equal(
    selfDogfoodReady({
      ...input,
      reviews: [{ ...input.reviews[0], commit_id: "b".repeat(40) }],
    }),
    false,
  );
  assert.equal(
    selfDogfoodReady({
      ...input,
      checks: [{ ...input.checks[0], app: { slug: "other" } }],
    }),
    false,
  );
});
test("self-dogfood rejects foreign heads, changed bases and malformed caller coordinates", () => {
  const input = readiness();
  assert.equal(
    selfDogfoodReady({
      ...input,
      pullRequest: {
        ...input.pullRequest,
        head: { sha, repo: { full_name: "other/buildchain" } },
      },
    }),
    false,
  );
  assert.equal(
    selfDogfoodReady({
      ...input,
      pullRequest: {
        ...input.pullRequest,
        base: { ...input.pullRequest.base, ref: "dev/v4/v4.0" },
      },
    }),
    false,
  );
  assert.throws(
    () => selfDogfoodCoordinates({ EVENT_NAME: "push" }),
    /pull request or explicit dispatch/,
  );
  assert.throws(
    () =>
      selfDogfoodCoordinates({
        eventName: "workflow_dispatch", event: {},
        request: { "candidate-sha": sha, "consumer-sha": sha, "pull-request": "1\nforged=value" },
      }),
    /exact immutable/,
  );
});
test("self-dogfood uses one public entry for primary and repaired runtime after review", () => {
  const w = YAML.parse(
    fs.readFileSync(".github/workflows/self-ops-bootstrap-dogfood.yml", "utf8"),
  );
  for (const channel of ["conformance", "alpha", "stable"]) {
    assert.equal(
      w.jobs[`primary-${channel}`].uses,
      "kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4",
    );
    assert.equal(
      w.jobs[`recovery-${channel}`].uses,
      "kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4",
    );
  }
  const action = YAML.parse(
    fs.readFileSync(
      "actions/workflow/dogfood/prepare/action.yml",
      "utf8",
    ),
  );
  const readinessIndex = action.runs.steps.findIndex(
      (s) => s.id === "readiness",
    ),
    generator = action.runs.steps.find((s) => s.id === "requests");
  assert.ok(readinessIndex >= 0);
  assert.match(generator.if, /steps.readiness.outputs.ready == 'true'/);
  assert.match(
    generator.uses,
    /\.buildchain\/runtime\/actions\/workflow\/dogfood\/generate/,
  );
  assert.equal(
    action.outputs.ready.value,
    "${{ steps.readiness.outputs.ready }}",
  );
});
