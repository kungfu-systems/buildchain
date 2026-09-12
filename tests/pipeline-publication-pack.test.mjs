import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { buildPipelineProducts } from "../packages/core/workflow/pipeline/build.js";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import {
  packPipelineProducts,
  verifyPipelineProductFiles,
} from "../packages/core/publication/pipeline/pack.js";
import { publicationPath } from "../packages/core/publication/pipeline/files.js";
import { qualifyPipelineProducts } from "../packages/core/publication/pipeline/qualification.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  retainPipelineProducts,
  restorePipelineProducts,
} from "../packages/core/publication/pipeline/sealed-products.js";
import { pipelineProductCapsules } from "../packages/core/publication/pipeline/capsules.js";
import { pipelineReleaseDocuments } from "../packages/core/publication/pipeline/documents.js";
import { createHash } from "node:crypto";
import {
  preparePipelineSigning,
  verifyPipelineSigning,
} from "../packages/core/publication/pipeline/signing.js";

test("real npm, native archive and PDF products are packed through one declared contract", async (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-publication-pack-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const type of ["npm", "binary", "paper"]) {
    const cwd = path.join(root, type);
    fs.cpSync(`templates/minimal-consumer/${type}`, cwd, { recursive: true });
    const contract = compileConsumerPlan(
      fs.readFileSync(path.join(cwd, ".buildchain/buildchain.toml"), "utf8"),
    );
    const source = {
      repository: "example/product",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    };
    const plan = planPipelinePublication({
      attempt: "attempt",
      generation: "generation",
      source,
      runtime: {
        repository: "kungfu-systems/buildchain",
        commit: "c".repeat(40),
        tree: "d".repeat(40),
      },
      publisher: {
        repository: "kungfu-systems/buildchain",
        workflow: ".github/workflows/.release-pipeline-products.yml",
        workflowSha: "e".repeat(40),
        job: "apply",
      },
      contract,
      route: contract.channels[1],
      version: "1.0.0-alpha.1",
      sourceTimestamp: "2026-09-13T00:00:00Z",
    });
    await buildPipelineProducts({ cwd, plan: contract, platform: "linux-x64" });
    if (type === "npm") {
      const file = path.join(cwd, "dist/package/package.json"),
        pkg = JSON.parse(fs.readFileSync(file));
      pkg.scripts = {
        prepack:
          "node -e \"require('fs').writeFileSync('forbidden-hook','ran')\"",
      };
      fs.writeFileSync(file, JSON.stringify(pkg));
    }
    const output = path.join(root, `${type}-packed`);
    const manifest = packPipelineProducts({
      cwd,
      output,
      plan,
      platform: "linux-x64",
      source,
    });
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(
      manifest.artifacts[0].kind,
      contract.products[0].artifacts[0].kind,
    );
    assert.equal(
      fs.existsSync(path.join(cwd, "dist/package/forbidden-hook")),
      false,
    );
    verifyPipelineProductFiles(output, manifest);
    const buildBody = {
      schema: "buildchain.pipeline-publication-build-readback/v1",
      outcome: "success",
      planRoot: plan.root,
      source,
      platforms: ["linux-x64"],
      artifactIds: [1],
      runId: 10,
      runAttempt: 1,
      providerSource: "f".repeat(40),
    };
    const build = { ...buildBody, root: recordDigest(buildBody) };
    const bundles = [
      {
        directory: output,
        manifest,
        providerArtifact: {
          id: 1,
          expired: false,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          workflow_run: { id: 10 },
        },
      },
    ];
    const qualificationInput = {
      plan,
      source,
      bundles,
      build,
      policyRoot: plan.contractRoot,
    };
    const qualification = qualifyPipelineProducts(qualificationInput);
    await assertPublicationMaterials({
      root,
      type,
      source,
      plan,
      qualification,
      bundles,
      output,
      manifest,
    });
    assert.equal(
      qualification.artifacts[0].digest,
      manifest.artifacts[0].digest,
    );
    assert.equal(qualification.qualification.sourceSha, source.commit);
    assert.throws(
      () => qualifyPipelineProducts({ ...qualificationInput, bundles: [] }),
      /every declared platform/,
    );
    assert.throws(
      () =>
        qualifyPipelineProducts({
          ...qualificationInput,
          build: { ...build, runId: 11 },
        }),
      /independent completed build/,
    );
    const changed = structuredClone(manifest);
    changed.artifacts[0].targets = [];
    const { root: ignored, ...changedBody } = changed;
    changed.root = recordDigest(changedBody);
    assert.throws(
      () =>
        qualifyPipelineProducts({
          ...qualificationInput,
          bundles: [{ ...bundles[0], manifest: changed }],
        }),
      /declared outputs and targets/,
    );
    fs.appendFileSync(path.join(output, manifest.artifacts[0].file), "changed");
    assert.throws(
      () => verifyPipelineProductFiles(output, manifest),
      /changed after/,
    );
  }
});

test("publication rejects symlinks and paths outside the product", (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-publication-path-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "target"), "owned");
  assert.throws(() => publicationPath(root, "../outside"), /escapes/);
  fs.symlinkSync(path.join(root, "target"), path.join(root, "link"));
  assert.throws(() => publicationPath(root, "link"), /symbolic/);
});

async function assertPublicationMaterials({
  root,
  type,
  source,
  plan,
  qualification,
  bundles,
  output,
  manifest,
}) {
  const materialBody = {
    schema: "buildchain.pipeline-version-materialization/v1",
    planRoot: plan.root,
    protectedSource: source,
    source,
    material: { version: plan.version, changes: [] },
  };
  const materialization = {
    ...materialBody,
    root: recordDigest(materialBody),
  };
  const capsules = pipelineProductCapsules({
    plan,
    materialization,
    qualified: qualification,
    bundles,
  });
  const signing = assertSigningAdapter({
    root,
    type,
    plan,
    materialization,
    qualification,
  });
  const documents = pipelineReleaseDocuments({
    plan,
    materialization,
    qualified: qualification,
    capsules,
    signing,
  });
  assert.equal(documents.passport.source.commit, source.commit);
  assert.equal(
    documents.passport.versionMaterialization.protectedSource.commit,
    source.commit,
  );
  assert.deepEqual(documents.transaction.transaction.phases, [
    "QUALIFY",
    "APPLY",
    "SETTLE",
  ]);
  assert.throws(
    () =>
      pipelineReleaseDocuments({
        plan: {
          ...plan,
          publisher: { ...plan.publisher, repository: "example/product" },
        },
        materialization,
        qualified: qualification,
        capsules,
        signing,
      }),
    /plan bytes/,
  );
  const retainedBytes = new Map();
  const archive = {
    put: async (bytes) => {
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      retainedBytes.set(digest, Buffer.from(bytes));
      return { id: retainedBytes.size, size: bytes.length, digest };
    },
    read: async ({ digest }) => retainedBytes.get(digest),
  };
  const sealed = await retainPipelineProducts(archive, qualification, bundles);
  const restored = path.join(root, `${type}-restored`);
  await restorePipelineProducts(archive, qualification, sealed, restored);
  await restorePipelineProducts(archive, qualification, sealed, restored);
  assert.deepEqual(
    fs.readFileSync(path.join(restored, manifest.artifacts[0].file)),
    fs.readFileSync(path.join(output, manifest.artifacts[0].file)),
  );
  retainedBytes.set(manifest.artifacts[0].digest, Buffer.from("corrupt"));
  await assert.rejects(
    restorePipelineProducts(archive, qualification, sealed, restored),
    /readback differs/,
  );
}

function assertSigningAdapter({
  root,
  type,
  plan,
  materialization,
  qualification,
}) {
  const directory = path.join(root, `${type}-signing`);
  const input = { plan, materialization, qualified: qualification, directory };
  const prepared = preparePipelineSigning(input);
  const bundlePath = path.join(directory, "bundle.json");
  fs.writeFileSync(bundlePath, "fixture signature bundle");
  let predicate = prepared.predicate;
  const execute = (command, args) => {
    assert.equal(command, "gh");
    assert.equal(
      args[args.indexOf("--signer-digest") + 1],
      plan.publisher.workflowSha,
    );
    assert.equal(
      args[args.indexOf("--source-digest") + 1],
      qualification.build.providerSource,
    );
    assert.notEqual(
      qualification.build.providerSource,
      qualification.source.commit,
    );
    assert.ok(args.includes("--deny-self-hosted-runners"));
    return JSON.stringify([
      {
        verificationResult: {
          statement: {
            predicateType: prepared.predicateType,
            predicate,
            subject: [{ digest: { sha256: prepared.subjectDigest } }],
          },
        },
      },
    ]);
  };
  const verified = verifyPipelineSigning({
    ...input,
    bundlePath,
    token: "fixture",
    execute,
  });
  assert.equal(verified.verified, true);
  predicate = {
    ...predicate,
    source: { ...predicate.source, commit: "0".repeat(40) },
  };
  assert.throws(
    () =>
      verifyPipelineSigning({
        ...input,
        bundlePath,
        token: "fixture",
        execute,
      }),
    /exact publication predicate/,
  );
  assert.throws(
    () =>
      verifyPipelineSigning({
        ...input,
        bundlePath,
        token: "fixture",
        execute: () => {
          throw new Error("signature verification rejected");
        },
      }),
    /signature verification rejected/,
  );
  return verified;
}
