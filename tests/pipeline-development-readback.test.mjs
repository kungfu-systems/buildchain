import test from "node:test";
import assert from "node:assert/strict";
import {
  createNextDevelopmentTransition,
  nextDevelopmentRoot,
  validateNextDevelopmentTransition,
} from "../packages/core/release/next-development-transition.js";
import { canonicalJson } from "../packages/core/release/discussion/envelope.js";
import { developmentTransitionReadback } from "../packages/core/publication/pipeline/development-proof.js";

const retained = (value) => JSON.parse(canonicalJson(value));

function fixture() {
  const transition = retained(
    createNextDevelopmentTransition({
      repository: "example/widget",
      model: { strategy: "semver", next: "auto" },
      sourcePaths: ["package.json"],
      derivedPaths: ["dist/contract.json", "dist/version.json"],
      completedAlpha: {
        outcome: "succeeded",
        version: "1.0.0-alpha.1",
        exactTag: "v1.0.0-alpha.1",
        releaseSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        publicationRoot: `sha256:${"c".repeat(64)}`,
        completedAt: "2026-09-13T01:00:00.000Z",
      },
    }),
  );
  const observation = {
    before: { files: {} },
    after: { version: transition.target.version, files: {} },
    evidence: { source: "d".repeat(40), pullRequest: 7 },
    createdAt: "2026-09-13T01:01:00.000Z",
  };
  for (const file of transition.adapter.allowedChangePaths) {
    observation.before.files[file] = "previous bytes";
    observation.after.files[file] = "next bytes";
  }
  return { transition, observation };
}

test("retained Alpha transition reads all declared version bytes through pending and merged states", () => {
  const { transition, observation } = fixture();
  assert.deepEqual(validateNextDevelopmentTransition(transition), transition);
  const pending = developmentTransitionReadback(transition, observation);
  assert.equal(pending.state.status, "pr-pending");
  assert.deepEqual(
    pending.materialization.paths.map(({ path }) => path),
    transition.adapter.allowedChangePaths,
  );
  assert.deepEqual(
    validateNextDevelopmentTransition(retained(pending)),
    retained(pending),
  );
  assert.deepEqual(
    developmentTransitionReadback(retained(transition), observation),
    pending,
  );
  const complete = developmentTransitionReadback(retained(transition), {
    ...observation,
    mergedAt: "2026-09-13T01:02:00.000Z",
  });
  assert.equal(complete.state.status, "verified");
  assert.deepEqual(
    validateNextDevelopmentTransition(retained(complete)),
    retained(complete),
  );
  assert.equal(complete.idempotencyKey, transition.idempotencyKey);
  assert.deepEqual(complete.completedAlpha, transition.completedAlpha);
});

test("canonical transition comparison still rejects adapter, target and effect-bound changes", () => {
  const { transition } = fixture();
  for (const mutate of [
    (value) => {
      value.adapter.environmentVariable = "OTHER_VERSION";
    },
    (value) => {
      value.effectBounds.refUpdates.push("refs/heads/alpha/v1/v1.0");
    },
    (value) => {
      value.target.anchor = { manifestPath: "release.json" };
    },
  ]) {
    const changed = structuredClone(transition);
    mutate(changed);
    assert.throws(() => validateNextDevelopmentTransition(changed));
  }
});

test("readback rejects missing bytes and incomplete, duplicate or undeclared materialization paths", () => {
  const { transition, observation } = fixture();
  for (const file of transition.adapter.allowedChangePaths) {
    const missing = structuredClone(observation);
    delete missing.after.files[file];
    assert.throws(
      () => developmentTransitionReadback(transition, missing),
      /exact declared file bytes/,
    );
  }
  const complete = developmentTransitionReadback(transition, observation);
  for (const mutate of [
    (paths) => paths.filter(({ path }) => path !== "package.json"),
    (paths) => paths.slice(1),
    (paths) => [...paths, paths[0]],
    (paths) => [...paths, { ...paths[0], path: "outside.txt" }],
    (paths) => [...paths].reverse(),
  ]) {
    const changed = structuredClone(complete);
    changed.materialization.paths = mutate(changed.materialization.paths);
    const { materializationRoot, ...body } = changed.materialization;
    changed.materialization.materializationRoot = nextDevelopmentRoot(body);
    assert.throws(
      () => validateNextDevelopmentTransition(changed),
      /materialization paths drifted/,
    );
  }
  const drifted = structuredClone(complete);
  drifted.materialization.paths[0].afterRoot = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => validateNextDevelopmentTransition(drifted),
    /materialization root drifted/,
  );
});
