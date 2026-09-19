import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  readPipelineContext,
  writePipelineContext,
} from "../packages/core/providers/github/pipeline-context-artifacts.js";

function fixture(t, schema = "buildchain.pipeline-publication-context/v1") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-context-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = {
    GITHUB_WORKSPACE: directory,
    GITHUB_REPOSITORY: "owner/product",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const source = { repository: "owner/product", commit: "a".repeat(40) };
  const value = {
    schema,
    runId: 100,
    runAttempt: 2,
    attempt: "retained-attempt",
    generation: "retained-generation",
    plan: { version: "4.1.3" },
    retained: "x".repeat(3474012),
  };
  if (schema.includes("-version-"))
    value.preparation = { source, purpose: "development" };
  else value.materialization = { source, qualification: { original: true } };
  const state = {
    reads: 0,
    bytes: null,
    corrupt: false,
    extra: false,
    mismatch: false,
  };
  const client = {
    uploadArtifact: async (name, files, root, options) => {
      assert.match(name, /^buildchain-context-2-[0-9a-f]{64}$/u);
      assert.equal(files.length, 1);
      assert.equal(path.dirname(files[0]), root);
      assert.deepEqual(options, { retentionDays: 30, compressionLevel: 0 });
      state.bytes = fs.readFileSync(files[0]);
      return { id: 123, digest: "b".repeat(64) };
    },
    downloadArtifact: async (id, options) => {
      state.reads++;
      assert.equal(id, 123);
      assert.deepEqual(Object.keys(options).sort(), ["expectedHash", "path"]);
      assert.equal(options.expectedHash, `sha256:${"b".repeat(64)}`);
      const bytes = state.corrupt
        ? Buffer.from(state.bytes.toString().replace('"4.1.3"', '"4.1.4"'))
        : state.bytes;
      fs.writeFileSync(path.join(options.path, "context.json"), bytes);
      if (state.extra)
        fs.writeFileSync(path.join(options.path, "other.json"), "{}");
      return { digestMismatch: state.mismatch };
    },
  };
  return { env, value, state, client, directory };
}

test("multi-megabyte publication context crosses jobs as a bounded exact reference", async (t) => {
  const f = fixture(t);
  const encoded = await writePipelineContext(f.value, f.env, f.client);
  assert(Buffer.byteLength(encoded) < 2048);
  assert.deepEqual(
    JSON.parse(encoded).materialization.source,
    f.value.materialization.source,
  );
  assert.deepEqual(
    await readPipelineContext(encoded, f.env, f.client),
    f.value,
  );
  assert.equal(f.state.reads, 1);
  assert.deepEqual(
    fs.readdirSync(path.join(f.directory, ".buildchain/context-material")),
    [],
  );
});

test("next-development version context preserves its full nested evidence and checkout source", async (t) => {
  const f = fixture(t, "buildchain.pipeline-version-context/v1");
  const encoded = await writePipelineContext(f.value, f.env, f.client);
  assert.deepEqual(
    JSON.parse(encoded).preparation.source,
    f.value.preparation.source,
  );
  assert.deepEqual(
    await readPipelineContext(encoded, f.env, f.client),
    f.value,
  );
});

test("small contexts remain inline without artifact access", async () => {
  const value = { operation: "wait" },
    client = {};
  const encoded = await writePipelineContext(value, {}, client);
  assert.deepEqual(await readPipelineContext(encoded, {}, client), value);
});

test("references cannot select another repository, run, or rerun", async (t) => {
  const f = fixture(t);
  const encoded = await writePipelineContext(f.value, f.env, f.client);
  for (const update of [
    { repository: "other/product" },
    { runId: 101 },
    { runAttempt: 3 },
  ]) {
    await assert.rejects(
      readPipelineContext(
        JSON.stringify({ ...JSON.parse(encoded), ...update }),
        f.env,
        f.client,
      ),
      /execution or material boundary/u,
    );
  }
  assert.equal(f.state.reads, 0);
});

test("checkout projection and immutable context bytes must agree before use", async (t) => {
  const f = fixture(t);
  const encoded = await writePipelineContext(f.value, f.env, f.client);
  const changed = JSON.parse(encoded);
  changed.materialization.source.commit = "c".repeat(40);
  await assert.rejects(
    readPipelineContext(JSON.stringify(changed), f.env, f.client),
    /checkout projection or root/u,
  );
  f.state.corrupt = true;
  await assert.rejects(
    readPipelineContext(encoded, f.env, f.client),
    /checkout projection or root/u,
  );
});

test("archive, inventory, length and upload identity failures are rejected", async (t) => {
  const f = fixture(t);
  const encoded = await writePipelineContext(f.value, f.env, f.client);
  f.state.mismatch = true;
  await assert.rejects(
    readPipelineContext(encoded, f.env, f.client),
    /archive or file inventory/u,
  );
  f.state.mismatch = false;
  f.state.extra = true;
  await assert.rejects(
    readPipelineContext(encoded, f.env, f.client),
    /archive or file inventory/u,
  );
  f.state.extra = false;
  f.state.bytes = f.state.bytes.subarray(1);
  await assert.rejects(
    readPipelineContext(encoded, f.env, f.client),
    /byte length/u,
  );
  await assert.rejects(
    writePipelineContext(f.value, f.env, {
      uploadArtifact: async () => ({ id: 1, digest: "invalid" }),
    }),
    /immutable provider coordinates/u,
  );
});

test("oversized inline input and retained material fail within explicit bounds", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    readPipelineContext(JSON.stringify(f.value), f.env, f.client),
    /bounded job output/u,
  );
  f.value.retained = "x".repeat(16 * 1024 * 1024);
  await assert.rejects(
    writePipelineContext(f.value, f.env, f.client),
    /retained material bound/u,
  );
  assert.equal(f.state.bytes, null);
});

test(
  "installed artifact SDK accepts the retained digest and rejects changed digests",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    const reference = JSON.parse(
      await writePipelineContext(f.value, f.env, f.client),
    );
    reference.artifact.digest = `sha256:${createHash("sha256").update(f.state.bytes).digest("hex")}`;
    const calls = [];
    const server = createServer(async (request, response) => {
      calls.push(request.url);
      if (request.url === "/context") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="context.json"',
        });
        response.end(f.state.bytes);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.workflow_run_backend_id, "fixture-run");
      assert.equal(body.workflow_job_run_backend_id, "fixture-job");
      response.setHeader("Content-Type", "application/json");
      if (request.url.endsWith("/ListArtifacts")) {
        assert.equal(body.id_filter, "123");
        response.end(
          JSON.stringify({
            artifacts: [
              {
                workflowRunBackendId: "fixture-run",
                workflowJobRunBackendId: "fixture-job",
                databaseId: "123",
                name: "context",
              },
            ],
          }),
        );
      } else {
        assert(request.url.endsWith("/GetSignedArtifactURL"));
        response.end(
          JSON.stringify({
            signedUrl: `http://127.0.0.1:${server.address().port}/context`,
          }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const overrides = {
      ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}`,
      ACTIONS_RUNTIME_TOKEN: `fixture.${Buffer.from(JSON.stringify({ scp: "Actions.Results:fixture-run:fixture-job" })).toString("base64url")}.fixture`,
    };
    for (const [key, value] of Object.entries(overrides)) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    assert.deepEqual(
      await readPipelineContext(JSON.stringify(reference), f.env),
      f.value,
    );
    reference.artifact.digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(
      readPipelineContext(JSON.stringify(reference), f.env),
      /archive or file inventory/u,
    );
    assert.equal(calls.filter((url) => url === "/context").length, 2);
  },
);
