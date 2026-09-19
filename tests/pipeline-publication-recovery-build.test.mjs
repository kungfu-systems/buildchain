import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { publicationBuildRecoveryFixture as fixture } from "./helpers/pipeline-publication-build-recovery.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { planRecoveryPublicationBuild } from "../packages/core/publication/pipeline/recovery-build-plan.js";
import { downloadRecoveryPublicationBuild } from "../packages/core/publication/pipeline/recovery-build-download.js";
import { qualifyPipelineProducts } from "../packages/core/publication/pipeline/qualification.js";
import { pipelineProductCapsules } from "../packages/core/publication/pipeline/capsules.js";
import { publicationRecoveryFixture } from "./helpers/pipeline-publication-recovery.mjs";

test("provider second-precision retention preserves the exact Capsule instant and immutable identity", () => {
  const f = publicationRecoveryFixture();
  const input = {
    ...f.context,
    qualified: f.retained.qualified,
    evaluatedAt: f.retained.qualified.qualification.issuedAt,
    bundles: [
      { providerArtifact: { id: 1, expires_at: "2026-09-14T00:00:00Z" } },
    ],
  };
  const before = structuredClone(input);
  assert.deepEqual(pipelineProductCapsules(input), f.retained.capsules);
  assert.deepEqual(input, before);
  for (const expiresAt of [
    "invalid",
    "2027-02-30T00:00:00Z",
    "2026-09-14T00:00:00+00:00",
    input.evaluatedAt,
    "2026-09-12T00:00:00Z",
    "",
  ]) {
    input.bundles[0].providerArtifact.expires_at = expiresAt;
    assert.throws(() => pipelineProductCapsules(input));
  }
});

test("partial publication reuses the successful original platform and qualifies actual bytes from two producer runs", async (t) => {
  const f = await fixture(t);
  const buildPlan = await planRecoveryPublicationBuild(
    f.session,
    f.plan,
    f.materialization,
    f.materials,
    f.host,
  );
  assert.deepEqual(buildPlan.scheduled, ["windows-x64"]);
  assert.deepEqual(buildPlan.segments[0].build.platforms, ["linux-x64"]);
  const context = {
    ...f.derived,
    runId: 200,
    runAttempt: 1,
    recovery: { build: buildPlan },
  };
  const { build, bundles } = await downloadRecoveryPublicationBuild(
    context,
    f.host,
    path.join(f.root, "download"),
  );
  assert.deepEqual(
    build.segments.map((segment) => segment.build.runId),
    [100, 200],
  );
  assert.equal(build.providerSource, f.runs.get(200).run.head_sha);
  assert.equal(build.operation, "requalify-original-product-segments");
  const qualified = qualifyPipelineProducts({
    plan: context.plan,
    source: context.materialization.source,
    build,
    bundles,
    policyRoot: context.plan.contractRoot,
  });
  assert.equal(qualified.artifacts.length, 2);
  assert.deepEqual(f.downloads, [100, 200]);
  const capsules = pipelineProductCapsules({ ...context, qualified, bundles });
  assert.equal(
    capsules.capsules[0].capsule.identity.runtimeRoot,
    recordDigest(f.plan.runtime),
  );
  assert.equal(
    capsules.capsules[1].capsule.identity.runtimeRoot,
    recordDigest(context.plan.runtime),
  );
  f.artifacts.get(100)[0].expired = true;
  await assert.rejects(
    downloadRecoveryPublicationBuild(
      context,
      f.host,
      path.join(f.root, "expired"),
    ),
    /retained artifact/,
  );
});

test("missing successful artifacts fail closed and changed product code schedules its platforms explicitly", async (t) => {
  const f = await fixture(t);
  f.artifacts.set(100, []);
  await assert.rejects(
    planRecoveryPublicationBuild(
      f.session,
      f.plan,
      f.materialization,
      f.materials,
      f.host,
    ),
    /retained artifact/,
  );
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes("actions/publication/") &&
    !url.includes(".wasm") &&
    url.endsWith(f.host.runtime.sha)
      ? { type: "file", sha: "3".repeat(40) }
      : request(url, options);
  const planned = await planRecoveryPublicationBuild(
    f.session,
    f.plan,
    f.materialization,
    f.materials,
    f.host,
  );
  assert.deepEqual(planned.scheduled, ["linux-x64", "windows-x64"]);
  assert.equal(planned.comparisons[0].compatible, false);
  assert.equal(planned.segments.length, 0);
});

test("a second interrupted recovery requalifies both original producer runs without scheduling another product build", async (t) => {
  const f = await fixture(t);
  const first = await planRecoveryPublicationBuild(
    f.session,
    f.plan,
    f.materialization,
    f.materials,
    f.host,
  );
  f.runs.get(200).run.status = "completed";
  f.runs.get(200).run.conclusion = "cancelled";
  const current = {
    ...f.oldContext,
    ...f.derived,
    attempt: f.derived.plan.attempt,
    runId: 200,
    platforms: [{ platform: "windows-x64" }],
    recovery: { build: first },
  };
  f.session.observed.history.push({
    identity: { id: current.attempt },
    generation: { id: f.plan.generation },
    events: [{ runtime: f.host.runtime }],
  });
  const materials = [
    {
      ...f.materials[0],
      id: `publication/predecessor-context/${recordDigest(f.oldContext).slice(7)}`,
    },
    {
      id: `publication/context/${recordDigest(current).slice(7)}`,
      value: current,
    },
  ];
  const recovered = await planRecoveryPublicationBuild(
    f.session,
    current.plan,
    current.materialization,
    materials,
    f.host,
  );
  assert.deepEqual(recovered.scheduled, []);
  assert.deepEqual(
    recovered.segments.map((segment) => segment.build.runId),
    [200, 100],
  );
  assert.deepEqual(
    recovered.segments.flatMap((segment) => segment.build.platforms).sort(),
    ["linux-x64", "windows-x64"],
  );
});
