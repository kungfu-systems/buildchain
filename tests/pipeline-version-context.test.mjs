import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { publicationFixture } from "./helpers/pipeline-publication-session.mjs";
import { preparePipelinePublication } from "../packages/core/publication/pipeline/prepare.js";
import { qualifyPipelineVersionContext } from "../packages/core/publication/pipeline/version-context.js";
import { pipelineVersionRegenerationResult } from "../packages/core/publication/pipeline/version-regeneration.js";
import {
  pipelineVersionArtifactName,
  pipelineVersionJobName,
} from "../packages/core/providers/github/pipeline-version-readback.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { publicationContext } from "../packages/core/publication/pipeline/context.js";

test("publication retains preparation before isolated execution and materializes only after independent provider qualification", async (t) => {
  const derivedFiles = { "dist/facts.json": '{"version":"1.0.0-alpha.1"}' };
  const { f, publisher, attempt } = await publicationFixture({ derivedFiles });
  const first = await preparePipelinePublication(attempt, publisher, f.host);
  assert.equal(first.operation, "regenerate");
  assert.equal(first.context.preparation.purpose, "publication");
  const { context } = first;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-version-context-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let downloads = 0;
  const client = {
    downloadArtifact: async (_id, options) => {
      downloads++;
      const result = pipelineVersionRegenerationResult(
        context.preparation,
        "linux-x64",
        {
          "package.json": JSON.stringify({
            name: "@example/product",
            version: "1.0.0-alpha.1",
          }),
          ...derivedFiles,
        },
      );
      fs.writeFileSync(
        path.join(options.path, "version.json"),
        JSON.stringify(result),
      );
      return { digestMismatch: false };
    },
  };
  await assert.rejects(
    qualifyPipelineVersionContext(
      { ...context, runAttempt: 2 },
      f.host,
      directory,
      client,
    ),
    /different provider execution/,
  );
  await assert.rejects(
    qualifyPipelineVersionContext(
      { ...context, definitionSha: "9".repeat(40) },
      f.host,
      directory,
      client,
    ),
    /not retained/,
  );
  assert.equal(downloads, 0);
  const callerPath = ".github/workflows/buildchain.yml";
  const bytes = Buffer.from(consumerWorkflows()[callerPath]);
  const caller = {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  };
  const original = f.host.request;
  f.host.request = async (url, options) => {
    if (url.includes("/contents/")) return caller;
    if (url.includes("/artifacts?"))
      return {
        total_count: 1,
        artifacts: [
          {
            id: 1,
            name: pipelineVersionArtifactName(context, "linux-x64"),
            digest: `sha256:${"a".repeat(64)}`,
            expired: false,
            workflow_run: { id: context.runId, head_sha: f.f.source.commit },
          },
        ],
      };
    return original(url, options);
  };
  f.host.runs.read = async () => ({
    run: {
      id: context.runId,
      run_attempt: context.runAttempt,
      head_sha: f.f.source.commit,
      event: "repository_dispatch",
      path: callerPath,
      repository: { full_name: f.host.repository },
      head_repository: { full_name: f.host.repository },
      referenced_workflows: [
        "public-ops-pipeline",
        ".release-pipeline-products",
        ".release-pipeline-version",
      ].map((name) => ({
        path: `kungfu-systems/buildchain/.github/workflows/${name}.yml@v4`,
        sha: publisher,
      })),
    },
    jobs: [
      {
        id: 11,
        name: pipelineVersionJobName(context.preparation, "linux-x64"),
        run_id: context.runId,
        run_attempt: context.runAttempt,
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  const qualified = await qualifyPipelineVersionContext(
    context,
    f.host,
    directory,
    client,
  );
  assert.equal(downloads, 1);
  assert.equal(
    (
      await qualified.journal.materials(
        "publication/version-publication-qualified/",
      )
    ).length,
    1,
  );
  const next = await preparePipelinePublication(attempt, publisher, f.host);
  assert.equal(next.operation, "build");
  assert.equal(
    next.context.materialization.material.regenerationBuildRoot,
    qualified.regeneration.build.root,
  );
  assert.deepEqual(
    next.context.materialization.source,
    context.preparation.source,
  );
  await publicationContext(next.context, f.host);
});
