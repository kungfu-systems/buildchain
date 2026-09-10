import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapReleaseLine } from "../packages/core/release/line/transaction.js";
import { lineBootstrapAction } from "../packages/core/release/line/action.js";
function ports(failAt) {
  const calls = [],
    result = { source: { sha: "a".repeat(40) } };
  return {
    calls,
    operations: {
      providers: {},
      ...Object.fromEntries(
        ["plan", "source", "governance"].map((name) => [
          name,
          async () => {
            calls.push(name);
            if (name === failAt) throw new Error(`failed ${name}`);
            return result;
          },
        ]),
      ),
    },
  };
}
test("release-line dry run returns a reviewable plan without any mutation provider", async () => {
  const p = ports();
  const result = await bootstrapReleaseLine(
    { apply: false },
    { ...p.operations, providers: undefined },
  );
  assert.deepEqual(p.calls, ["plan"]);
  assert.equal(result.applied, false);
  assert.equal(result.plan.source.sha, "a".repeat(40));
});
test("release-line source transaction completes before repository governance", async () => {
  const p = ports();
  await bootstrapReleaseLine(
    { apply: true, repository: "owner/repo" },
    p.operations,
  );
  assert.deepEqual(p.calls, ["plan", "source", "governance"]);
});
test("release-line failures and missing provider authority prevent later effects", async () => {
  for (const failed of ["plan", "source", "governance"]) {
    const p = ports(failed);
    await assert.rejects(
      bootstrapReleaseLine(
        { apply: true, repository: "owner/repo" },
        p.operations,
      ),
      new RegExp(`failed ${failed}`),
    );
    assert.equal(p.calls.at(-1), failed);
  }
  const p = ports();
  await assert.rejects(
    bootstrapReleaseLine(
      { apply: true, repository: "owner/repo" },
      { ...p.operations, providers: undefined },
    ),
    /scoped repository providers/,
  );
  assert.deepEqual(p.calls, ["plan"]);
});
test("string flags and malformed request cannot obtain release effects from ambient environment", async () => {
  for (const request of [{ apply: "true" }, [], null])
    await assert.rejects(
      lineBootstrapAction(
        { getInput: () => JSON.stringify(request) },
        { BUILDCHAIN_APPLY: "true" },
      ),
      /boolean|object/,
    );
});
