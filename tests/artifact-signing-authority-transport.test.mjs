import { githubRequest } from "../packages/core/providers/github/signing-request.js";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthorityDispatchRef } from "../packages/core/build/signing/dispatch.js";

test("authority polling retries transient GET transport failures without replaying dispatch POSTs", async () => {
  let getAttempts = 0;
  const delays = [];
  const result = await githubRequest(
    "/repos/kungfu-systems/buildchain/actions/workflows/public-release-signing-authority.yml/runs",
    {
      token: "test-token",
      fetchImpl: async () => {
        getAttempts += 1;
        if (getAttempts === 1) throw new TypeError("fetch failed");
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [] }),
        };
      },
      delayImpl: async (milliseconds) => delays.push(milliseconds),
      maxAttempts: 3,
      warnImpl: () => {},
    },
  );
  assert.deepEqual(result, { workflow_runs: [] });
  assert.equal(getAttempts, 2);
  assert.deepEqual(delays, [1_000]);

  let postAttempts = 0;
  await assert.rejects(
    () =>
      githubRequest(
        "/repos/kungfu-systems/buildchain/actions/workflows/public-release-signing-authority.yml/dispatches",
        {
          token: "test-token",
          method: "POST",
          body: { ref: resolveAuthorityDispatchRef("v4") },
          fetchImpl: async () => {
            postAttempts += 1;
            throw new TypeError("fetch failed");
          },
          delayImpl: async () =>
            assert.fail("dispatch POST must not be retried"),
          maxAttempts: 5,
          warnImpl: () => {},
        },
      ),
    /fetch failed/,
  );
  assert.equal(postAttempts, 1);
});
