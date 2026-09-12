import test from "node:test";
import assert from "node:assert/strict";
import {
  pipelineEvent,
  channelRoute,
} from "../packages/core/workflow/pipeline/events.js";

const repository = "example/consumer";
const envelope = (extra = {}) => ({
  repository: { full_name: repository },
  ...extra,
});

test("normal events select live reconciliation without trusting payload authority", () => {
  assert.deepEqual(
    pipelineEvent(
      "pull_request",
      envelope({
        action: "synchronize",
        pull_request: { number: 7, head: { sha: "forged" } },
      }),
      repository,
    ),
    { kind: "pull-request", pullRequest: 7, terminalOnly: false },
  );
  assert.equal(
    pipelineEvent(
      "pull_request_target",
      envelope({
        action: "closed",
        pull_request: { number: 7 },
      }),
      repository,
    ).terminalOnly,
    true,
  );
  assert.throws(() =>
    pipelineEvent(
      "pull_request_target",
      envelope({ action: "opened" }),
      repository,
    ),
  );
  assert.throws(() =>
    pipelineEvent(
      "pull_request",
      envelope({
        action: "opened",
        pull_request: { number: "7" },
      }),
      repository,
    ),
  );
  assert.throws(
    () =>
      pipelineEvent(
        "repository_dispatch",
        envelope({
          action: "buildchain-attempt-wake",
          client_payload: { attempt: `attempt-${"a".repeat(64)}`, warrant: {} },
        }),
        repository,
      ),
    /only its exact/,
  );
  assert.equal(
    pipelineEvent(
      "push",
      envelope({
        ref: "refs/heads/buildchain/attempts/internal",
        after: "a".repeat(40),
      }),
      repository,
    ).kind,
    "ignore",
  );
});

test("channel selection rejects ambiguity, forks and unauthorized branches", () => {
  const route = { from: "feature/*", to: "dev/v1/v1.0", operation: "develop" };
  const pr = {
    base: { ref: route.to, repo: { full_name: repository } },
    head: { ref: "feature/topic", repo: { full_name: repository } },
  };
  assert.equal(channelRoute({ channels: [route] }, pr, repository), route);
  assert.throws(
    () => channelRoute({ channels: [route, route] }, pr, repository),
    /Ambiguous/,
  );
  assert.equal(
    channelRoute(
      { channels: [{ ...route, from: "feature/other" }] },
      pr,
      repository,
    ),
    null,
  );
  pr.head.repo.full_name = "attacker/consumer";
  assert.throws(
    () => channelRoute({ channels: [route] }, pr, repository),
    /repository-owned/,
  );
});
