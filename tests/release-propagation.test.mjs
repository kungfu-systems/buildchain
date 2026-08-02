import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RELEASE_PROPAGATION_WORK_STAGES,
  claimReleasePropagationWork,
  completeReleasePropagationWork,
  createReleasePropagationReceipt,
  createReleasePropagationStageReceipt,
  createReleasePropagationWork,
  createPackageReleasePropagationCapture,
  normalizePackageReleasePropagationConfig,
  normalizeReleasePropagationGraph,
  planReleasePropagation,
  recordReleasePropagationStage,
  repairReleasePropagationWork,
  verifyReleasePropagationWork,
  writeReleasePropagationLock,
} from "@kungfu-tech/buildchain/release-propagation";
import { sha256Json } from "../packages/core/release-propagation-common.js";
import { contentRoot } from "../packages/core/release-propagation-work-control.js";
import { withWorkRoot } from "../packages/core/release-propagation-work.js";
import {
  capturePackageReleasePropagation,
  readConfigAtSource,
} from "../scripts/capture-package-release-propagation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const fixture = path.join(root, "fixtures", "release-propagation-shaped");
const workflowPath = path.join(root, ".github", "workflows", "release-propagation.yml");
const promotionWorkflowPath = path.join(root, ".github", "workflows", ".release-candidate-promote.yml");
const publicPromotionWorkflowPath = path.join(root, ".github", "workflows", "release-candidate-promote.yml");

function packageCaptureConfig() {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-package-release-propagation",
    sourceNode: "kfd",
    graph: readJson("graph.json"),
    targets: ["site-libkungfu-dev"],
  };
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(fixture, rel), "utf8"));
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function shaRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function workRef(kind, subject) {
  return {
    schema: "kungfu.assignment-graph.work-ref/v1",
    workspace_identity_root: shaRoot(`${subject}:workspace`),
    object_kind: kind,
    subject,
    version_root: shaRoot(`${subject}:version`),
    cut_root: shaRoot(`${subject}:cut`),
  };
}

function typedReference(kind, identity, status, familyState) {
  return {
    kind,
    identity,
    root: shaRoot(`${kind}:${identity}`),
    factWorld: familyState.factWorld,
    cutRoot: familyState.cutRoot,
    schema: `kungfu.test.${kind}/v1`,
    status,
  };
}

function propagationWorkContext(mode = "execute") {
  const familyState = {
    schema: "kungfu.work-control.initiative-family-state/v2",
    stateRoot: shaRoot("family-state"),
    v1ProjectionRoot: shaRoot("family-v1"),
    typedBindingRoot: shaRoot("family-bindings"),
    factWorld: "kungfu-test-world",
    cutRoot: shaRoot("family-cut"),
  };
  return {
    parentWorkRef: workRef("initiative", "paper-publication"),
    childWorkRef: workRef("assignment", "site-propagation"),
    familyState,
    authority: mode === "execute"
      ? {
          mode: "execute",
          publishToProduction: true,
          allowedActions: [...RELEASE_PROPAGATION_WORK_STAGES].sort(),
          executionPrincipal: "codex/pro-1802",
          sourceControlPrincipal: "dongkeren",
          executionWarrant: typedReference("execution-warrant", "warrant-1", "active", familyState),
        }
      : {
          mode: "capture-only",
          publishToProduction: false,
          allowedActions: [],
          executionPrincipal: null,
          sourceControlPrincipal: null,
          executionWarrant: null,
        },
    supersedesWorkRoot: "",
  };
}

function stageReceipt(
  work,
  outcome = "success",
  failure = null,
  decision = null,
  actorIdentity = "",
) {
  const stage = work.state.currentStage;
  const kinds = {
    materialize: "release-lock",
    "verify-release": "release-contract-verification",
    "push-branch": "git-branch-reconciliation",
    "pull-request": "github-pull-request",
    preview: "preview-deployment",
    "independent-review": "github-pr-approval",
    "protected-merge": "github-merge",
    staging: "staging-deployment",
    "production-release": "production-release-pr",
    "production-deploy": "production-deployment",
    complete: "work-control-decision",
  };
  const locators = {
    materialize: work.downstream.lockPath,
    "verify-release": "buildchain://release-propagation/verify-release",
    "push-branch": "buildchain://release-propagation/branch-reconciliation",
    "pull-request": `https://github.com/${work.downstream.repository}/pull/1`,
    preview: `https://github.com/${work.downstream.repository}/actions/runs/1`,
    "independent-review": `https://github.com/${work.downstream.repository}/pull/1#pullrequestreview-1`,
    "protected-merge": `https://github.com/${work.downstream.repository}/commit/${"a".repeat(40)}`,
    staging: `https://github.com/${work.downstream.repository}/actions/runs/2`,
    "production-release": `https://github.com/${work.downstream.repository}/pull/2`,
    "production-deploy": `https://github.com/${work.downstream.repository}/actions/runs/3`,
    complete: "kungfu://decision/site-production-completion",
  };
  const deployedRevision = "a".repeat(40);
  const boundRelease = {
    releaseRoot: work.upstream.releaseRoot,
    releaseLockRoot: `sha256:${work.downstream.lockSha256}`,
    sourceSha: work.upstream.release.sourceSha,
    tagTargetSha: work.upstream.release.tagTargetSha,
  };
  let evidence;
  if (stage === "online-readback") {
    const deployment = work.stageReceipts
      .find((entry) => entry.stage === "production-deploy")
      .evidence.find((entry) => entry.kind === "production-deployment");
    evidence = [
      ["production-status", work.downstream.executionProfile.productionStatusUrl],
      ...work.downstream.executionProfile.readbackUrls.map((url) => ["online-artifact", url]),
    ].map(([kind, locator]) => {
      const expectedArtifact = deployment.claims.readbackArtifacts
        .find((entry) => entry.url === locator);
      const claims = {
        deployedRevision,
        ...boundRelease,
        artifactRoot: deployment.claims.artifactRoot,
        contentSha256: expectedArtifact?.contentSha256 || shaRoot(`status:${locator}`),
      };
      return {
        kind,
        root: contentRoot(claims),
        locator,
        repository: work.downstream.repository,
        revision: deployedRevision,
        httpStatus: 200,
        bytes: 128,
        claims,
      };
    });
  } else if (stage === "independent-review") {
    const claims = {
      provider: "github",
      reviewState: "APPROVED",
      reviewerIdentity: actorIdentity || "kungfu-origin",
      pullRequestAuthorIdentity: work.authority.sourceControlPrincipal,
      headRevision: deployedRevision,
    };
    evidence = [{
      kind: "github-pr-approval",
      root: contentRoot(claims),
      locator: locators[stage],
      repository: work.downstream.repository,
      revision: deployedRevision,
      httpStatus: null,
      bytes: 0,
      claims,
    }];
  } else if (stage === "production-deploy") {
    const claims = {
      deploymentRunUrl: locators[stage],
      deployedRevision,
      ...boundRelease,
      artifactRoot: shaRoot(`site-artifact:${work.revision}`),
      readbackArtifacts: work.downstream.executionProfile.readbackUrls.map((url) => ({
        url,
        contentSha256: shaRoot(`readback:${url}`),
      })),
    };
    evidence = [{
      kind: "production-deployment",
      root: contentRoot(claims),
      locator: locators[stage],
      repository: work.downstream.repository,
      revision: deployedRevision,
      httpStatus: null,
      bytes: 0,
      claims,
    }];
  } else {
    evidence = [{
      kind: kinds[stage] || `${stage}-diagnostic`,
      root: decision?.root || shaRoot(`${stage}:${work.revision}:${outcome}`),
      locator: locators[stage] || `buildchain://release-propagation/${stage}`,
      repository: work.downstream.repository,
      revision: deployedRevision,
      httpStatus: null,
      bytes: 0,
      claims: null,
    }];
  }
  if (stage === "production-deploy") {
    const claims = {
      deployedRevision,
      rollbackRevision: "b".repeat(40),
    };
    evidence.push({
      kind: "rollback-coordinate",
      root: contentRoot(claims),
      locator: `https://github.com/${work.downstream.repository}/commit/${"b".repeat(40)}`,
      repository: work.downstream.repository,
      revision: "b".repeat(40),
      httpStatus: null,
      bytes: 0,
      claims,
    });
  }
  return createReleasePropagationStageReceipt({
    work,
    outcome,
    observedAt: "2026-08-01T06:00:00.000Z",
    actor: {
      kind: stage === "independent-review" ? "github-reviewer" : "agent",
      identity: actorIdentity
        || (stage === "independent-review" ? "kungfu-origin" : "codex/pro-1802"),
    },
    summary: `${stage} ${outcome}`,
    evidence,
    failure,
  });
}

test("release propagation graph preserves alpha channel and exact upstream facts", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });

  assert.equal(plan.contract, "kungfu-buildchain-release-propagation-plan");
  assert.equal(plan.summary.targetCount, 1);
  assert.equal(plan.targets[0].repository, "kungfu-systems/site-libkungfu-dev");
  assert.equal(plan.targets[0].channel, "alpha");
  assert.equal(plan.targets[0].lockPath, "buildchain.upstreams/kfd.release.json");
  assert.equal(plan.targets[0].lock.upstream.package.version, "1.4.0-alpha.3");
  assert.equal(plan.targets[0].lock.upstream.package.integrity, readJson("upstream-alpha.json").package.integrity);
  assert.equal(plan.targets[0].lock.upstream.releasePassport.sha256, "2222222222222222222222222222222222222222222222222222222222222222");
  assert.equal(plan.targets[0].lock.propagation.floatingTags, false);
  assert.match(plan.targets[0].propagationKey, /^[0-9a-f]{64}$/);
  assert.match(
    plan.targets[0].branch,
    /^buildchain\/release-propagation\/kungfu-systems-kfd\/1\.4\.0-alpha\.3-alpha-[0-9a-f]{12}$/,
  );
  assert.match(plan.targets[0].lock.lockSha256, /^[0-9a-f]{64}$/);
});

test("release propagation graph preserves stable release channel", () => {
  const release = {
    ...readJson("upstream-alpha.json"),
    channel: "release",
    tag: "v1.4.0",
    package: {
      ...readJson("upstream-alpha.json").package,
      version: "1.4.0",
    },
  };
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: release,
  });

  assert.equal(plan.targets[0].channel, "release");
  assert.equal(plan.targets[0].lock.upstream.package.version, "1.4.0");
});

test("release propagation rejects npm gitHead, exact tag, source SHA, and package version disagreement", () => {
  const release = readJson("upstream-alpha.json");
  assert.throws(
    () => planReleasePropagation({
      graph: readJson("graph.json"),
      upstreamRelease: {
        ...release,
        package: { ...release.package, gitHead: "f".repeat(40) },
      },
    }),
    /gitHead must match sourceSha/,
  );
  assert.throws(
    () => planReleasePropagation({
      graph: readJson("graph.json"),
      upstreamRelease: { ...release, tag: "v1.4.0-alpha" },
    }),
    /tag must exactly match/,
  );
  assert.throws(
    () => planReleasePropagation({
      graph: readJson("graph.json"),
      upstreamRelease: { ...release, tagTargetSha: "e".repeat(40) },
    }),
    /tag target must match sourceSha/,
  );
});

test("release propagation graph carries publication archive payload without package facts", () => {
  const graph = readJson("graph.json");
  graph.nodes.unshift({
    id: "paper",
    repository: "kungfu-systems/paper-observer-declared-timelines",
  });
  graph.edges.unshift({
    id: "paper-to-site",
    from: "paper",
    to: "site-libkungfu-dev",
    channelPolicy: "preserve",
  });

  const plan = planReleasePropagation({
    graph,
    upstreamRelease: readJson("upstream-publication.json"),
  });

  assert.equal(plan.source, "paper");
  assert.equal(plan.targets[0].lock.upstream.package, undefined);
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.version, "0.1.0-alpha.1");
  assert.equal(
    plan.targets[0].lock.upstream.publicationArtifact.immutableVersionUrl,
    "https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0-alpha.1/",
  );
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.registry.sha256, "6666666666666666666666666666666666666666666666666666666666666666");
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.primaryArtifact.path, "_build/main.pdf");
});

test("release propagation graph rejects cycles before planning downstream PRs", () => {
  const graph = readJson("graph.json");
  graph.edges.push({
    id: "site-to-kfd",
    from: "site-libkungfu-dev",
    to: "kfd",
  });
  assert.throws(
    () => normalizeReleasePropagationGraph(graph),
    /cycle: kfd -> site-libkungfu-dev -> kfd/,
  );
});

test("release propagation write-lock writes exact downstream lock", () => {
  const cwd = tempDir("release-propagation-lock");
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const result = writeReleasePropagationLock({
    plan,
    target: "site-libkungfu-dev",
    cwd,
  });
  const lock = JSON.parse(fs.readFileSync(result.path, "utf8"));

  assert.equal(path.relative(cwd, result.path), "buildchain.upstreams/kfd.release.json");
  assert.equal(lock.contract, "kungfu-buildchain-release-propagation-lock");
  assert.equal(lock.downstream.repository, "kungfu-systems/site-libkungfu-dev");
  assert.equal(lock.upstream.tag, "v1.4.0-alpha.3");
  assert.equal(lock.lockSha256, result.lockSha256);
  assert.equal(result.status, "written");
  assert.equal(result.changed, true);
  const reused = writeReleasePropagationLock({
    plan,
    target: "site-libkungfu-dev",
    cwd,
  });
  assert.equal(reused.status, "reused");
  assert.equal(reused.changed, false);
});

test("release propagation receipt keeps alpha truth independent from site visibility", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const target = plan.targets[0];
  const receipt = createReleasePropagationReceipt({
    plan,
    target: target.target,
    lockResult: {
      lockSha256: target.lock.lockSha256,
      propagationKey: target.propagationKey,
      status: "written",
    },
    prOutcome: {
      state: "created",
      number: 235,
      url: "https://github.com/kungfu-systems/site-libkungfu-dev/pull/235",
      branch: target.branch,
    },
    stagingState: "pending",
    productionState: "not-requested",
    observedAt: "2026-07-30T00:00:00.000Z",
  });

  assert.equal(receipt.contract, "kungfu-buildchain-release-propagation-receipt");
  assert.equal(receipt.states["package-published"].state, "complete");
  assert.equal(receipt.states["alpha-complete"].state, "complete");
  assert.equal(receipt.states["staging-visible"].state, "pending");
  assert.equal(receipt.states["production-visible"].state, "not-requested");
  assert.equal(receipt.downstream.pullRequest.state, "created");
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
});

test("agent-native propagation work binds Family State v2, exact WorkRefs, release lock, and execution authority", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const context = propagationWorkContext();
  const work = createReleasePropagationWork({
    plan,
    target: "site-libkungfu-dev",
    workContext: context,
    expectedDownstreamBaseSha: "a".repeat(40),
  });
  const repeated = createReleasePropagationWork({
    plan,
    target: "site-libkungfu-dev",
    workContext: context,
    expectedDownstreamBaseSha: "a".repeat(40),
  });
  const status = verifyReleasePropagationWork(work);

  assert.equal(work.contract, "kungfu-buildchain-release-propagation-work");
  assert.equal(work.workControl.familyState.schema, "kungfu.work-control.initiative-family-state/v2");
  assert.equal(work.workControl.childWorkRef.schema, "kungfu.assignment-graph.work-ref/v1");
  assert.equal(work.authority.executionWarrant.kind, "execution-warrant");
  assert.equal(work.intent.publishToProduction, true);
  assert.equal(work.downstream.expectedBaseSha, "a".repeat(40));
  assert.equal(work.downstream.lockSha256, plan.targets[0].lock.lockSha256);
  assert.equal(work.contentRoot, repeated.contentRoot);
  assert.equal(status.currentStage, "materialize");
  assert.equal(status.nextAction.action, "record");
  assert.equal(status.productionVisible, false);
});

test("capture-only propagation stays paused until an exact active Warrant claims it", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const context = propagationWorkContext("capture-only");
  const captured = createReleasePropagationWork({
    plan,
    workContext: context,
    expectedDownstreamBaseSha: "b".repeat(40),
  });

  assert.equal(captured.state.lifecycle, "paused");
  assert.equal(captured.state.nextAction.action, "claim");
  assert.throws(
    () => recordReleasePropagationStage({
      work: captured,
      expectedWorkRoot: captured.contentRoot,
      receipt: stageReceipt(captured),
    }),
    /must be claimed/,
  );

  const executing = propagationWorkContext("execute").authority;
  const claimed = claimReleasePropagationWork({
    work: captured,
    expectedWorkRoot: captured.contentRoot,
    authority: executing,
  });
  assert.equal(claimed.state.lifecycle, "ready");
  assert.equal(claimed.state.currentStage, "materialize");
  assert.equal(claimed.previousWorkRoot, captured.contentRoot);
});

test("automatic capture emits deterministic typed WorkRefs and binds Family State only when claimed", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const captured = createReleasePropagationWork({
    plan,
    target: "site-libkungfu-dev",
    expectedDownstreamBaseSha: "b".repeat(40),
  });
  const repeated = createReleasePropagationWork({
    plan,
    target: "site-libkungfu-dev",
    expectedDownstreamBaseSha: "b".repeat(40),
  });
  assert.equal(captured.contentRoot, repeated.contentRoot);
  assert.equal(captured.workControl.bindingState, "pending");
  assert.equal(captured.workControl.familyState, null);
  assert.equal(captured.authority.mode, "capture-only");
  assert.equal(captured.state.nextAction.action, "claim");
  assert.match(captured.workControl.parentWorkRef.subject, /^buildchain:release:/);
  assert.match(captured.workControl.childWorkRef.subject, /^buildchain:propagation:/);

  const context = propagationWorkContext("execute");
  const claimed = claimReleasePropagationWork({
    work: captured,
    expectedWorkRoot: captured.contentRoot,
    familyState: context.familyState,
    authority: context.authority,
  });
  assert.equal(claimed.workId, captured.workId);
  assert.equal(claimed.workControl.bindingState, "bound");
  assert.deepEqual(claimed.workControl.familyState, context.familyState);
  assert.equal(claimed.authority.mode, "execute");
});

test("propagation work resumes retryable failure and completes only after online readback plus Work Control decision", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const context = propagationWorkContext();
  let work = createReleasePropagationWork({
    plan,
    workContext: context,
    expectedDownstreamBaseSha: "c".repeat(40),
  });
  const failedReceipt = stageReceipt(work, "failure", {
    class: "expected-old-mismatch",
    code: "remote-advanced",
    summary: "downstream base advanced before the leased push",
  });
  work = recordReleasePropagationStage({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt: failedReceipt,
  });
  assert.equal(work.state.lifecycle, "retryable-failure");
  assert.equal(work.state.nextAction.action, "repair");

  const repair = stageReceipt(work, "repair");
  work = repairReleasePropagationWork({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt: repair,
  });
  assert.equal(work.state.lifecycle, "ready");
  assert.equal(work.state.recoveryCursor.attempt, 2);

  while (work.state.currentStage !== "complete") {
    if (work.state.currentStage === "independent-review") {
      assert.throws(
        () => stageReceipt(work, "success", null, null, "codex/pro-1802"),
        /must differ from the executor and pull request author/,
      );
      assert.throws(
        () => stageReceipt(work, "success", null, null, "dongkeren"),
        /must differ from the executor and pull request author/,
      );
    }
    if (work.state.currentStage === "online-readback") {
      assert.throws(
        () => createReleasePropagationStageReceipt({
          work,
          observedAt: "2026-08-01T06:00:00.000Z",
          actor: { kind: "agent", identity: "codex/pro-1802" },
          summary: "generic readback is not qualifying",
          evidence: [{
            kind: "online-readback-evidence",
            root: shaRoot("generic-readback"),
            locator: "github://generic/readback",
            repository: work.downstream.repository,
            revision: "a".repeat(40),
            httpStatus: null,
            bytes: 0,
            claims: null,
          }],
        }),
        /stage-specific evidence/,
      );
      const staleArtifactEvidence = structuredClone(stageReceipt(work).evidence);
      const staleArtifact = staleArtifactEvidence.find((entry) => entry.kind === "online-artifact");
      staleArtifact.claims.contentSha256 = shaRoot("stale-online-artifact");
      staleArtifact.root = contentRoot(staleArtifact.claims);
      assert.throws(
        () => createReleasePropagationStageReceipt({
          work,
          observedAt: "2026-08-01T06:00:00.000Z",
          actor: { kind: "agent", identity: "codex/pro-1802" },
          summary: "stale online artifact cannot qualify",
          evidence: staleArtifactEvidence,
        }),
        /online artifact digest does not match/,
      );
      const staleRevisionEvidence = structuredClone(stageReceipt(work).evidence);
      for (const entry of staleRevisionEvidence) {
        entry.revision = "c".repeat(40);
        entry.claims.deployedRevision = "c".repeat(40);
        entry.root = contentRoot(entry.claims);
      }
      assert.throws(
        () => createReleasePropagationStageReceipt({
          work,
          observedAt: "2026-08-01T06:00:00.000Z",
          actor: { kind: "agent", identity: "codex/pro-1802" },
          summary: "stale deployment revision cannot qualify",
          evidence: staleRevisionEvidence,
        }),
        /does not bind the production deployment/,
      );
    }
    const receipt = stageReceipt(work);
    work = recordReleasePropagationStage({
      work,
      expectedWorkRoot: work.contentRoot,
      receipt,
    });
  }
  assert.equal(verifyReleasePropagationWork(work).productionVisible, false);
  assert.throws(
    () => recordReleasePropagationStage({
      work,
      expectedWorkRoot: work.contentRoot,
      receipt: stageReceipt(work),
    }),
    /requires a Work Control completion decision/,
  );

  const completionDecision = typedReference(
    "decision",
    "site-production-completion",
    "accepted",
    context.familyState,
  );
  const completionReceipt = stageReceipt(work, "success", null, completionDecision);
  work = completeReleasePropagationWork({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt: completionReceipt,
    completionDecision,
  });
  const completed = verifyReleasePropagationWork(work);
  assert.equal(completed.lifecycle, "complete");
  assert.equal(completed.productionVisible, true);
  assert.equal(completed.completionQualified, true);
  assert.equal(work.stageReceipts.at(-2).stage, "online-readback");
  assert.equal(work.stageReceipts.at(-1).stage, "complete");
});

test("propagation work fails closed on malformed WorkRef, floating base, and hard safety failures", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const malformed = propagationWorkContext();
  malformed.childWorkRef.version_root = "v1";
  assert.throws(
    () => createReleasePropagationWork({
      plan,
      workContext: malformed,
      expectedDownstreamBaseSha: "main",
    }),
    /sha256 content root|40-character Git SHA/,
  );

  const context = propagationWorkContext();
  const mismatchedPlan = structuredClone(plan);
  mismatchedPlan.targets[0].lock.upstream.package = {
    ...mismatchedPlan.targets[0].lock.upstream.package,
  };
  mismatchedPlan.targets[0].lock.upstream.sourceSha = "e".repeat(40);
  mismatchedPlan.targets[0].lock.upstream.tagTargetSha = "e".repeat(40);
  mismatchedPlan.targets[0].lock.upstream.package.gitHead = "e".repeat(40);
  mismatchedPlan.targets[0].lock.lockSha256 = sha256Json({
    ...mismatchedPlan.targets[0].lock,
    lockSha256: undefined,
  });
  assert.throws(
    () => createReleasePropagationWork({
      plan: mismatchedPlan,
      workContext: context,
      expectedDownstreamBaseSha: "d".repeat(40),
    }),
    /upstream release disagrees with its lock/,
  );
  let work = createReleasePropagationWork({
    plan,
    workContext: context,
    expectedDownstreamBaseSha: "d".repeat(40),
  });
  work = recordReleasePropagationStage({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt: stageReceipt(work, "failure", {
      class: "release-contract-mismatch",
      code: "npm-githead-tag-mismatch",
      summary: "npm gitHead and the immutable release tag disagree",
    }),
  });
  assert.equal(work.state.lifecycle, "hard-safety-gate");
  assert.equal(work.state.nextAction.action, "hard-safety-gate");
  assert.throws(
    () => repairReleasePropagationWork({
      work,
      expectedWorkRoot: work.contentRoot,
      receipt: stageReceipt(work, "repair"),
    }),
    /only retryable/,
  );
});

test("propagation work rejects a forged latest expected-old receipt chain", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  let work = createReleasePropagationWork({
    plan,
    workContext: propagationWorkContext(),
    expectedDownstreamBaseSha: "d".repeat(40),
  });
  work = recordReleasePropagationStage({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt: stageReceipt(work),
  });
  const forged = structuredClone(work);
  const latest = forged.stageReceipts.at(-1);
  latest.expectedWorkRoot = shaRoot("unrelated-work-cut");
  const receiptBody = { ...latest };
  delete receiptBody.receiptRoot;
  latest.receiptRoot = contentRoot(receiptBody);
  forged.state.recoveryCursor.lastReceiptRoot = latest.receiptRoot;
  assert.throws(
    () => verifyReleasePropagationWork(withWorkRoot(forged)),
    /latest stage receipt does not bind the predecessor work root/,
  );
});

test("release propagation CLI plans and writes downstream locks", () => {
  const cwd = tempDir("release-propagation-cli");
  const planPath = path.join(cwd, "plan.json");
  const planOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "plan",
    "--graph",
    path.join(fixture, "graph.json"),
    "--upstream-release",
    path.join(fixture, "upstream-alpha.json"),
    "--output",
    planPath,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const plan = JSON.parse(planOutput);

  assert.equal(plan.targets[0].target, "site-libkungfu-dev");
  assert.equal(fs.existsSync(planPath), true);

  const lockOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "write-lock",
    "--plan",
    planPath,
    "--target",
    "kungfu-systems/site-libkungfu-dev",
    "--cwd",
    cwd,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const lockResult = JSON.parse(lockOutput);

  assert.equal(fs.existsSync(lockResult.path), true);

  const prOutcomePath = path.join(cwd, "pr-outcome.json");
  fs.writeFileSync(prOutcomePath, `${JSON.stringify({
    state: "planned",
    branch: plan.targets[0].branch,
  }, null, 2)}\n`);
  const lockResultPath = path.join(cwd, "lock-result.json");
  fs.writeFileSync(lockResultPath, `${JSON.stringify(lockResult, null, 2)}\n`);
  const receiptOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "receipt",
    "--plan",
    planPath,
    "--lock-result",
    lockResultPath,
    "--pr-outcome",
    prOutcomePath,
    "--target",
    "site-libkungfu-dev",
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const receipt = JSON.parse(receiptOutput);
  assert.equal(receipt.propagationKey, plan.targets[0].propagationKey);
});

test("release propagation CLI fails fast when target is ambiguous", () => {
  const failure = spawnSync(process.execPath, [
    bin,
    "release-propagation",
    "write-lock",
    "--plan",
    JSON.stringify({
      contract: "kungfu-buildchain-release-propagation-plan",
      targets: [],
    }),
  ], { cwd: root, encoding: "utf8" });

  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /expected exactly one propagation target/);
});

test("release propagation staged change detection includes a new lock and preserves true no-op", () => {
  const cwd = tempDir("release-propagation-git-change");
  const lockPath = "buildchain.upstreams/kfd.release.json";
  const absoluteLockPath = path.join(cwd, lockPath);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], { cwd });
  fs.mkdirSync(path.dirname(absoluteLockPath), { recursive: true });
  fs.writeFileSync(absoluteLockPath, "{\"version\":1}\n");
  execFileSync("git", ["add", "--", lockPath], { cwd });
  assert.notEqual(spawnSync("git", ["diff", "--cached", "--quiet", "--", lockPath], { cwd }).status, 0);
  execFileSync("git", ["commit", "-m", "test: add release lock"], { cwd, stdio: "ignore" });
  fs.writeFileSync(absoluteLockPath, "{\"version\":1}\n");
  execFileSync("git", ["add", "--", lockPath], { cwd });
  assert.equal(spawnSync("git", ["diff", "--cached", "--quiet", "--", lockPath], { cwd }).status, 0);
});

test("release propagation reusable workflow invokes the checked out Buildchain runtime", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /buildchain-repository:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /repository: \$\{\{ inputs\.buildchain-repository \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3' \}\}/);
  assert.match(workflow, /path: \.buildchain\/runtime/);
  assert.match(workflow, /Install Buildchain runtime dependencies/);
  assert.match(workflow, /pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/);
  assert.equal(workflow.includes("node bin/buildchain.mjs release-propagation"), false);
  assert.ok(
    (workflow.match(/node \.buildchain\/runtime\/bin\/buildchain\.mjs release-propagation/g) || []).length >= 8,
  );
  assert.match(workflow, /node \.buildchain\/runtime\/bin\/buildchain\.mjs "\$\{args\[@\]\}"/);
  assert.match(workflow, /LOCK_PATH: \$\{\{ steps\.plan\.outputs\.lock_path \}\}/);
  assert.match(workflow, /downstream-prepare-command:/);
  assert.match(workflow, /BUILDCHAIN_UPSTREAM_PACKAGE_VERSION:/);
  assert.match(workflow, /Refresh managed README badges/);
  assert.match(workflow, /badges readme --cwd \. --write/);
  assert.match(workflow, /downstream-verify-command:/);
  assert.ok(
    workflow.indexOf("Prepare downstream release update") <
      workflow.indexOf("Refresh managed README badges"),
  );
  assert.ok(
    workflow.indexOf("Refresh managed README badges") <
      workflow.indexOf("Verify downstream release update"),
  );
  assert.match(
    workflow,
    /git add --all[\s\S]*?if git diff --cached --quiet/,
  );
  assert.doesNotMatch(workflow, /if git diff --quiet/);
  assert.doesNotMatch(workflow, /git add \./);
  assert.match(workflow, /git ls-remote --heads origin "refs\/heads\/\$BRANCH"/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$BRANCH:\$remote_sha"/);
  assert.doesNotMatch(workflow, /git push --force(?:\s|$)/);
  assert.match(workflow, /kungfu-buildchain-release-propagation-branch-reconciliation/);
  assert.match(workflow, /"kind":"propagation-branch-reconciliation"/);
  assert.match(workflow, /gh pr list[\s\S]*--state open[\s\S]*--head "\$BRANCH"/);
  assert.match(workflow, /git commit --signoff -m "\$TITLE"/);
  assert.ok(
    workflow.indexOf("Verify downstream release update") < workflow.indexOf("Create or update downstream PR"),
  );
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /fromJSON\(inputs\.upstream-release-json\)\.repository/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /downstream-update-command:/);
  assert.match(workflow, /Apply consumer-owned downstream update/);
  assert.match(workflow, /BUILDCHAIN_PROPAGATION_LOCK_PATH:/);
  assert.match(workflow, /bash --noprofile --norc -e -u -o pipefail -c "\$DOWNSTREAM_UPDATE_COMMAND"/);
  assert.match(workflow, /release-propagation receipt/);
  assert.match(workflow, /agent-work-context-json:/);
  assert.match(workflow, /agent-work-mode:/);
  assert.match(workflow, /agent-work-mode == 'capture-only'/);
  assert.match(workflow, /release-propagation work create/);
  assert.match(workflow, /release-propagation work receipt/);
  assert.match(workflow, /release-propagation work record/);
  assert.match(workflow, /release-propagation work status/);
  assert.match(workflow, /propagation-work-next-action:/);
  assert.match(workflow, /steps\.propagation-work\.outputs\.execute == 'true'/);
  assert.match(workflow, /release propagation found duplicate matching PRs/);
  assert.equal(workflow.includes("gh pr create \\\n"), true);
});

test("release propagation replaces a surviving managed branch with an exact lease and rejects stale writers", () => {
  const cwd = tempDir("release-propagation-lease");
  const remote = path.join(cwd, "remote.git");
  const seed = path.join(cwd, "seed");
  const writer = path.join(cwd, "writer");
  const stale = path.join(cwd, "stale");
  const concurrent = path.join(cwd, "concurrent");
  const branch = "buildchain/release-propagation/kfd";
  const ref = `refs/heads/${branch}`;
  const run = (args, options = {}) => execFileSync("git", args, {
    cwd: options.cwd || cwd,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  }).trim();
  const configure = (repo) => {
    run(["config", "user.name", "Buildchain Test"], { cwd: repo });
    run(["config", "user.email", "buildchain@example.test"], { cwd: repo });
  };
  const commitFile = (repo, file, content, message) => {
    fs.writeFileSync(path.join(repo, file), content);
    run(["add", "--", file], { cwd: repo });
    run(["commit", "-m", message], { cwd: repo });
  };

  run(["init", "--bare", remote]);
  run(["clone", remote, seed]);
  configure(seed);
  run(["checkout", "-b", "main"], { cwd: seed });
  commitFile(seed, "base.txt", "base\n", "test: base");
  run(["push", "-u", "origin", "main"], { cwd: seed });
  run(["checkout", "-b", branch], { cwd: seed });
  commitFile(seed, "kfd.release.json", "{\"version\":1}\n", "test: first lock");
  run(["push", "-u", "origin", branch], { cwd: seed });
  run(["checkout", "main"], { cwd: seed });
  run(["merge", "--no-ff", branch, "-m", "test: merge first propagation"], { cwd: seed });
  run(["push", "origin", "main"], { cwd: seed });

  run(["clone", "--branch", "main", remote, writer]);
  configure(writer);
  run(["checkout", "-b", branch], { cwd: writer });
  commitFile(writer, "kfd.release.json", "{\"version\":2}\n", "test: next lock");
  const observed = run(["ls-remote", "--heads", "origin", ref], { cwd: writer }).split("\t")[0];
  run([
    "push",
    `--force-with-lease=${ref}:${observed}`,
    "origin",
    `HEAD:${ref}`,
  ], { cwd: writer });
  assert.equal(
    run(["ls-remote", "--heads", "origin", ref], { cwd: writer }).split("\t")[0],
    run(["rev-parse", "HEAD"], { cwd: writer }),
  );

  run(["clone", remote, stale]);
  configure(stale);
  run(["checkout", "-b", branch, `origin/${branch}`], { cwd: stale });
  const staleLease = run(["rev-parse", "HEAD"], { cwd: stale });
  commitFile(stale, "kfd.release.json", "{\"version\":3}\n", "test: stale lock");

  run(["clone", remote, concurrent]);
  configure(concurrent);
  run(["checkout", "-b", branch, `origin/${branch}`], { cwd: concurrent });
  commitFile(concurrent, "concurrent.txt", "advanced\n", "test: concurrent advance");
  run(["push", "origin", `HEAD:${ref}`], { cwd: concurrent });

  const rejected = spawnSync("git", [
    "push",
    `--force-with-lease=${ref}:${staleLease}`,
    "origin",
    `HEAD:${ref}`,
  ], { cwd: stale, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /stale info|rejected/);
});

test("package release propagation config is strict and source-package bound", () => {
  const config = packageCaptureConfig();
  const normalized = normalizePackageReleasePropagationConfig(config);
  assert.equal(normalized.sourceNode, "kfd");
  assert.deepEqual(normalized.targets, ["site-libkungfu-dev"]);
  assert.equal(normalized.graph.nodes[1].executionProfile.workflow, "buildchain-web-surface.yml");

  assert.throws(
    () => normalizePackageReleasePropagationConfig({ ...config, unexpected: true }),
    /invalid field set/,
  );
  const nestedDrift = structuredClone(config);
  nestedDrift.graph.nodes[1].unknownCommand = "echo unsafe";
  assert.throws(
    () => normalizePackageReleasePropagationConfig(nestedDrift),
    /unknown fields: unknownCommand/,
  );
});

test("package release capture emits one deterministic paused Work with zero execution authority", () => {
  const release = readJson("upstream-alpha.json");
  const capture = createPackageReleasePropagationCapture({
    config: packageCaptureConfig(),
    upstreamRelease: release,
    expectedBaseShas: { "site-libkungfu-dev": "9".repeat(40) },
  });
  assert.equal(capture.works.length, 1);
  const [{ work, status }] = capture.works;
  assert.equal(work.upstream.release.sourceSha, release.sourceSha);
  assert.equal(work.upstream.release.tagTargetSha, release.sourceSha);
  assert.equal(work.upstream.release.package.gitHead, release.sourceSha);
  assert.equal(work.downstream.expectedBaseSha, "9".repeat(40));
  assert.equal(work.authority.mode, "capture-only");
  assert.equal(work.intent.publishToProduction, false);
  assert.equal(work.state.lifecycle, "paused");
  assert.equal(status.nextAction.action, "claim");
  assert.equal(status.contentRoot, work.contentRoot);

  const repeated = createPackageReleasePropagationCapture({
    config: packageCaptureConfig(),
    upstreamRelease: release,
    expectedBaseShas: { "site-libkungfu-dev": "9".repeat(40) },
  });
  assert.equal(repeated.works[0].work.contentRoot, work.contentRoot);
});

test("package release capture materializes a restart-safe artifact set", () => {
  const outputDir = tempDir("package-release-capture");
  const captured = capturePackageReleasePropagation({
    config: packageCaptureConfig(),
    upstreamRelease: readJson("upstream-alpha.json"),
    expectedBaseShas: { "site-libkungfu-dev": "9".repeat(40) },
    outputDir,
  });
  const propagationKey = captured.works[0].propagationKey;
  const work = JSON.parse(fs.readFileSync(path.join(outputDir, "work", propagationKey, "work.json"), "utf8"));
  const status = JSON.parse(fs.readFileSync(path.join(outputDir, "work", propagationKey, "status.json"), "utf8"));
  assert.equal(work.contentRoot, captured.works[0].work.contentRoot);
  assert.equal(status.nextAction.action, "claim");
  assert.equal(verifyReleasePropagationWork(work).contentRoot, work.contentRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, "upstream-release.json"), "utf8")).tag, "v1.4.0-alpha.3");
});

test("package release capture recovers an exact source commit missing from a shallow checkout", () => {
  const sandbox = tempDir("package-release-shallow-source");
  const seed = path.join(sandbox, "seed");
  const remote = path.join(sandbox, "remote.git");
  const shallow = path.join(sandbox, "shallow");
  execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd: seed });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], { cwd: seed });
  fs.writeFileSync(
    path.join(seed, "buildchain.release-propagation.json"),
    `${JSON.stringify(packageCaptureConfig())}\n`,
  );
  execFileSync("git", ["add", "buildchain.release-propagation.json"], { cwd: seed });
  execFileSync("git", ["commit", "-m", "test: release source"], { cwd: seed, stdio: "ignore" });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(seed, "later.txt"), "later\n");
  execFileSync("git", ["add", "later.txt"], { cwd: seed });
  execFileSync("git", ["commit", "-m", "test: later checkout"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["clone", "--bare", seed, remote], { stdio: "ignore" });
  execFileSync("git", ["clone", "--depth=1", `file://${remote}`, shallow], { stdio: "ignore" });

  assert.notEqual(
    spawnSync("git", ["cat-file", "-e", `${sourceSha}^{commit}`], { cwd: shallow }).status,
    0,
  );
  const recovered = readConfigAtSource(
    sourceSha,
    "buildchain.release-propagation.json",
    shallow,
  );
  assert.equal(recovered.normalized.sourceNode, "kfd");
  assert.equal(
    spawnSync("git", ["cat-file", "-e", `${sourceSha}^{commit}`], { cwd: shallow }).status,
    0,
  );
});

test("package release capture rejects the alpha.48 tag and npm source mismatch class", () => {
  const release = readJson("upstream-alpha.json");
  assert.throws(
    () => createPackageReleasePropagationCapture({
      config: packageCaptureConfig(),
      upstreamRelease: { ...release, tagTargetSha: "8".repeat(40) },
      expectedBaseShas: { "site-libkungfu-dev": "9".repeat(40) },
    }),
    /tag target must match sourceSha/,
  );
  assert.throws(
    () => createPackageReleasePropagationCapture({
      config: packageCaptureConfig(),
      upstreamRelease: {
        ...release,
        package: { ...release.package, gitHead: "7".repeat(40) },
      },
      expectedBaseShas: { "site-libkungfu-dev": "9".repeat(40) },
    }),
    /package gitHead must match sourceSha/,
  );
});

test("promotion finalization exposes generic package Work capture without downstream writes", () => {
  const workflow = fs.readFileSync(promotionWorkflowPath, "utf8");
  assert.match(workflow, /release-propagation-config-path:/);
  assert.match(workflow, /steps\.promote\.outputs\.finalization-needed != 'true'/);
  assert.match(workflow, /capture-package-release-propagation\.mjs/);
  assert.match(workflow, /steps\.promote\.outputs\.transaction-release-sha/);
  assert.match(workflow, /steps\.promote\.outputs\.public-release-tag/);
  assert.match(workflow, /release-propagation-work-artifact:/);
  const captureBlock = workflow.slice(
    workflow.indexOf("Capture exact package release propagation work"),
    workflow.indexOf("Bundle release-candidate-promotion controller evidence"),
  );
  assert.doesNotMatch(captureBlock, /git push|gh pr create|gh pr merge/);
});

test("alpha package propagation does not pass a new input into the older stable shell", () => {
  const workflow = fs.readFileSync(publicPromotionWorkflowPath, "utf8");
  const alphaBlock = workflow.slice(
    workflow.indexOf("  alpha:"),
    workflow.indexOf("  stable:"),
  );
  const stableBlock = workflow.slice(workflow.indexOf("  stable:"));
  assert.match(alphaBlock, /release-propagation-config-path:/);
  assert.doesNotMatch(stableBlock, /release-propagation-config-path:/);
});
