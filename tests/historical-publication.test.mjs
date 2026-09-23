import assert from "node:assert/strict";
import test from "node:test";
import { publishCandidate } from "../packages/core/release/promote-candidate/publication.js";
import {
  HISTORICAL_PUBLISHER,
  HISTORICAL_PROMOTION_SCHEMA,
} from "../packages/core/release/promotion/compatibility-context.js";

const legacy = {
  "historical-inputs-json": JSON.stringify({
    schema: HISTORICAL_PROMOTION_SCHEMA,
    inputs: {},
  }),
  "publisher-workflow-path": HISTORICAL_PUBLISHER,
};
test("historical publication executes the same provider transaction without a Discussion call", async () => {
  const context = {
    octokit: {
      graphql() {
        throw new Error("not granted");
      },
    },
  };
  const receipt = {
    outputs: { "release-receipt-root": `sha256:${"a".repeat(64)}` },
  };
  const actual = await publishCandidate(legacy, context, {
    historical(request, received) {
      assert.equal(request, legacy);
      assert.equal(received, context);
      return receipt;
    },
    current() {
      assert.fail("legacy caller selected Discussions");
    },
  });
  assert.equal(actual, receipt);
});
test("current publication retains its Discussion transaction and provider errors propagate", async () => {
  const failure = new Error("provider readback failed");
  await assert.rejects(
    async () =>
      publishCandidate(
        {},
        {},
        {
          historical() {
            assert.fail("current caller selected historical transport");
          },
          current() {
            throw failure;
          },
        },
      ),
    (error) => error === failure,
  );
  await assert.rejects(
    async () =>
      publishCandidate(
        legacy,
        {},
        {
          historical() {
            throw failure;
          },
        },
      ),
    (error) => error === failure,
  );
});
test("publisher identities and recovery transports cannot be mixed", () => {
  for (const request of [
    { ...legacy, "historical-inputs-json": "" },
    {
      ...legacy,
      "publisher-workflow-path": ".github/workflows/.release-promote.yml",
    },
    { ...legacy, "resume-discussion-id": "D_123" },
  ])
    assert.throws(() => publishCandidate(request, {}), /Historical/);
});
