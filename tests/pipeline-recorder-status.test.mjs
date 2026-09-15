import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publishRecorderStatus } from "../packages/core/workflow/pipeline/recorder-status.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture(permission = "write") {
  const source = { repository: "example/consumer", commit: "1".repeat(40) };
  const context = { source, runId: 42, runAttempt: 1 };
  const body = { ...context, outcome: "success" };
  const readback = { ...body, root: recordDigest(body) };
  const bytes = Buffer.from(
    `jobs:\n  record-build:\n    name: Record product build\n    permissions:\n      checks: write\n      statuses: ${permission}\n`,
  );
  const file = {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  };
  const run = {
    id: 42,
    run_attempt: 1,
    referenced_workflows: [
      {
        path: "kungfu-systems/buildchain/.github/workflows/.ops-pipeline-execute.yml@v4-alpha",
        sha: "2".repeat(40),
      },
    ],
  };
  const effects = [];
  const host = {
    repository: source.repository,
    runId: 42,
    runAttempt: 1,
    runs: { read: async () => ({ run }) },
    request: async (url, options) => {
      if (options?.method === "POST") {
        effects.push({ url, ...options });
        return {};
      }
      assert.match(
        url,
        /contents\/\.github\/workflows\/\.ops-pipeline-execute.yml\?ref=2{40}$/u,
      );
      return file;
    },
  };
  return { context, readback, file, run, effects, host };
}

test("recorder publishes source-bound status only with its actual immutable entry permission", async () => {
  const f = fixture();
  assert.deepEqual(await publishRecorderStatus(f.context, f.readback, f.host), {
    published: true,
  });
  assert.equal(f.effects.length, 1);
  assert.equal(
    f.effects[0].url,
    `/repos/example/consumer/statuses/${f.context.source.commit}`,
  );
  const old = fixture("read");
  assert.deepEqual(
    await publishRecorderStatus(old.context, old.readback, old.host),
    { published: false },
  );
  assert.equal(old.effects.length, 0);
});

test("old entry without status scope retains checks and failed builds never receive successful status", async () => {
  const f = fixture();
  f.readback.outcome = "failure";
  const { root, ...body } = f.readback;
  f.readback.root = recordDigest(body);
  assert.deepEqual(await publishRecorderStatus(f.context, f.readback, f.host), {
    published: false,
  });
  assert.equal(f.effects.length, 0);
});

test("changed source, execution, workflow blob and ambiguous entry fail closed", async () => {
  for (const change of [
    (f) => {
      f.context.runId++;
    },
    (f) => {
      f.host.runAttempt++;
    },
    (f) => {
      f.readback.source = { ...f.readback.source, commit: "4".repeat(40) };
    },
    (f) => {
      f.file.sha = "5".repeat(40);
    },
    (f) => {
      f.run.referenced_workflows.push(f.run.referenced_workflows[0]);
    },
    (f) => {
      f.run.referenced_workflows = [];
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(publishRecorderStatus(f.context, f.readback, f.host));
    assert.equal(f.effects.length, 0);
  }
});

test("a declared status capability cannot silently ignore provider refusal", async () => {
  const f = fixture(),
    request = f.host.request;
  f.host.request = (url, options) => {
    if (options?.method === "POST") throw new Error("status permission denied");
    return request(url, options);
  };
  await assert.rejects(
    publishRecorderStatus(f.context, f.readback, f.host),
    /status permission denied/u,
  );
});
