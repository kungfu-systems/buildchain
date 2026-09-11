import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGitHubCliApi } from "../packages/core/providers/github-cli-api.js";
import { enqueueNextDevelopmentPullRequest } from "../packages/core/release/promote-candidate/next-development-queue.js";

function failedResponse(value, status = 1) {
  try {
    return execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('private diagnostic'); process.exit(Number(process.argv[2]));",
        JSON.stringify(value),
        String(status),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // Only the structured response can supply semantics; command text is not evidence.
    error.message = `gh failed with status ${status}`;
    throw error;
  }
}

test("GitHub CLI GraphQL failure preserves pending queue semantics across a real nonzero subprocess", async () => {
  let calls = 0;
  const waits = [];
  const client = createGitHubCliApi(() => {
    calls++;
    if (calls === 1)
      return failedResponse({
        errors: [
          {
            message: "mergeability check has not yet completed",
            type: "UNPROCESSABLE",
          },
        ],
      });
    return JSON.stringify({
      data: { enqueuePullRequest: { mergeQueueEntry: { id: "entry" } } },
    });
  });
  await enqueueNextDevelopmentPullRequest({
    pull: { node_id: "PR_exact" },
    headSha: "a".repeat(40),
    mutationOctokit: {
      graphql: (query, variables) =>
        client.post("graphql", { query, variables }),
    },
    wait: async (value) => waits.push(value),
    maxPolls: 2,
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("GitHub CLI preserves HTTP status rather than confusing it with process exit status", () => {
  const client = createGitHubCliApi(() =>
    failedResponse({ message: "Service Unavailable", status: "503" }),
  );
  assert.throws(
    () => client.json("repos/example/project"),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "Service Unavailable");
      assert.ok(!error.message.includes("private diagnostic"));
      return true;
    },
  );
});

test("GitHub CLI opaque process failures remain failures without exposing diagnostics", () => {
  const client = createGitHubCliApi(() => {
    throw Object.assign(new Error("private command context"), {
      status: 7,
      stdout: "not JSON",
      stderr: "private diagnostic",
    });
  });
  assert.throws(
    () => client.post("graphql", {}),
    (error) => {
      assert.equal(error.exitCode, 7);
      assert.equal(error.status, undefined);
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
});

test("GitHub CLI success preserves structured input and paginated results", () => {
  const calls = [];
  const client = createGitHubCliApi(
    (program, args, options) => {
      calls.push({ program, args, options });
      return args.includes("--slurp")
        ? '[{"jobs":[1]},{"jobs":[2]}]'
        : '{"data":{"ok":true}}';
    },
    { GH_TOKEN: "synthetic-token" },
  );
  assert.deepEqual(
    client.post("graphql", { query: "query { viewer { login } }" }),
    { data: { ok: true } },
  );
  assert.deepEqual(
    client.pages("repos/example/project/actions/runs/1/jobs", "jobs"),
    [1, 2],
  );
  assert.equal(
    calls[0].options.input,
    JSON.stringify({ query: "query { viewer { login } }" }),
  );
  assert.ok(!calls[0].args.includes("synthetic-token"));
});
