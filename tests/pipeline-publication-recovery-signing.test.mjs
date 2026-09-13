import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { publicationRecoveryFixture } from "./helpers/pipeline-publication-recovery.mjs";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import {
  consumerWorkflows,
  PIPELINE_ENTRY,
  RECOVERY_ENTRY,
} from "../packages/core/consumer/contract/entries.js";
import { buildPipelineProducts } from "../packages/core/workflow/pipeline/build.js";
import { packPipelineProducts } from "../packages/core/publication/pipeline/pack.js";
import { qualifyPipelineProducts } from "../packages/core/publication/pipeline/qualification.js";
import { pipelineProductCapsules } from "../packages/core/publication/pipeline/capsules.js";
import { retainPipelineProducts } from "../packages/core/publication/pipeline/sealed-products.js";
import { deriveRecoveryPublicationPlan } from "../packages/core/publication/pipeline/recovery-plan.js";
import { requalifySealedPublication } from "../packages/core/publication/pipeline/recovery-qualification.js";
import { preparePipelineSigning } from "../packages/core/publication/pipeline/signing.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

async function fixture(t) {
  const f = publicationRecoveryFixture();
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-signing-recovery-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "source"),
    output = path.join(root, "packed");
  fs.cpSync("templates/minimal-consumer/paper", cwd, { recursive: true });
  const contract = compileConsumerPlan(
    fs.readFileSync(path.join(cwd, ".buildchain/buildchain.toml"), "utf8"),
  );
  await buildPipelineProducts({ cwd, plan: contract, platform: "linux-x64" });
  const { plan, materialization } = f.context;
  const source = materialization.source;
  const manifest = packPipelineProducts({
    cwd,
    output,
    plan,
    platform: "linux-x64",
    source,
  });
  const jobs = [
    {
      id: 1001,
      run_id: 100,
      run_attempt: 1,
      name: "Build publication (linux-x64)",
      status: "completed",
      conclusion: "success",
    },
  ];
  const body = {
    schema: "buildchain.pipeline-publication-build-readback/v1",
    outcome: "success",
    planRoot: plan.root,
    source,
    runId: 100,
    runAttempt: 1,
    providerSource: source.commit,
    platforms: ["linux-x64"],
    artifactIds: [1],
    jobs,
  };
  const bundles = [
    {
      directory: output,
      manifest,
      providerArtifact: {
        id: 1,
        expired: false,
        expires_at: new Date(f.now.getTime() + 86400000).toISOString(),
        workflow_run: { id: 100 },
      },
    },
  ];
  const qualified = qualifyPipelineProducts({
    plan,
    source,
    bundles,
    build: { ...body, root: recordDigest(body) },
    policyRoot: plan.contractRoot,
    now: new Date(f.now.getTime() - 7200000),
  });
  const capsules = pipelineProductCapsules({
    plan,
    materialization,
    qualified,
    bundles,
    evaluatedAt: qualified.qualification.issuedAt,
  });
  const bytes = new Map();
  const archive = {
    put: async (value) => {
      const digest = `sha256:${createHash("sha256").update(value).digest("hex")}`;
      bytes.set(digest, Buffer.from(value));
      return { id: bytes.size, digest, size: value.length };
    },
    read: async (handle) => bytes.get(handle.digest),
  };
  const sealed = await retainPipelineProducts(archive, qualified, bundles);
  const host = {
    repository: source.repository,
    runs: {
      read: async (id) => ({
        run: {
          id,
          run_attempt: 1,
          status: id === 100 ? "completed" : "in_progress",
          conclusion: id === 100 ? "success" : null,
          event: id === 100 ? "pull_request" : "workflow_dispatch",
          head_sha: id === 100 ? source.commit : "8".repeat(40),
          repository: { full_name: source.repository },
          head_repository: { full_name: source.repository },
          path: `.github/workflows/${id === 100 ? "buildchain" : "buildchain-recover"}.yml`,
          referenced_workflows: [
            {
              path: `kungfu-systems/buildchain/${id === 100 ? PIPELINE_ENTRY : RECOVERY_ENTRY}@v4`,
              sha: "9".repeat(40),
            },
          ],
        },
        jobs: id === 100 ? jobs : [],
      }),
    },
    request: async (url) => {
      const name = url.includes("buildchain-recover")
        ? ".github/workflows/buildchain-recover.yml"
        : ".github/workflows/buildchain.yml";
      const value = Buffer.from(consumerWorkflows()[name]);
      return {
        type: "file",
        encoding: "base64",
        size: value.length,
        content: value.toString("base64"),
        sha: createHash("sha1")
          .update(`blob ${value.length}\0`)
          .update(value)
          .digest("hex"),
      };
    },
  };
  const derived = deriveRecoveryPublicationPlan(
    plan,
    materialization,
    f.execution,
    f.context.recovery.planRoot,
  );
  return {
    ...f,
    context: { ...f.context, ...derived },
    prepared: { qualified, capsules, sealed },
    originalPlan: plan,
    originalMaterialization: materialization,
    archive,
    bytes,
    host,
    directory: path.join(root, "recovery"),
  };
}

test("signing failure requalifies the same real sealed PDF and its actual original jobs under the repaired publisher", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.prepared);
  const result = await requalifySealedPublication(f);
  assert.equal(
    result.qualified.build.schema,
    "buildchain.pipeline-publication-requalification/v1",
  );
  assert.equal(result.qualified.build.runId, 200);
  assert.equal(result.qualified.build.predecessorBuild.runId, 100);
  assert.deepEqual(result.qualified.artifacts, f.prepared.qualified.artifacts);
  assert.deepEqual(result.sealed.products, f.prepared.sealed.products);
  assert.deepEqual(
    result.capsules.capsules[0].capsule.retentionPromise,
    f.prepared.capsules.capsules[0].capsule.retentionPromise,
  );
  const signing = preparePipelineSigning({
    ...f.context,
    qualified: result.qualified,
    directory: path.join(f.directory, "signing"),
    evaluatedAt: f.now.toISOString(),
  });
  assert.equal(
    signing.predicate.publisher.workflowSha,
    f.execution.publisher.workflowSha,
  );
  assert.equal(signing.predicate.provider.source, "8".repeat(40));
  assert.deepEqual(f.prepared, before);
  f.bytes.set(
    f.prepared.qualified.artifacts[0].digest,
    Buffer.from("changed PDF"),
  );
  await assert.rejects(requalifySealedPublication(f), /readback differs/);
});
