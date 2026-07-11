import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBuildchainChannel } from "../scripts/buildchain-channel-router.mjs";
import { generateChannelBuildWorkflow } from "../scripts/generate-channel-build-workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = { routerRef: "v2-alpha", packageVersion: "2.12.0-alpha.0" };

test("development and prerelease events select the generic major alpha", () => {
  assert.deepEqual(resolveBuildchainChannel({ ...base, eventName: "pull_request", gitRef: "refs/pull/1/merge" }), {
    channel: "alpha",
    major: 2,
    buildchainRef: "v2-alpha",
    selectionSource: "development-default",
    reason: "non-release pull_request event",
  });
  assert.equal(
    resolveBuildchainChannel({ ...base, publishChannel: "alpha", eventName: "workflow_dispatch" }).buildchainRef,
    "v2-alpha",
  );
  assert.equal(
    resolveBuildchainChannel({ ...base, eventName: "release", releasePrerelease: "true" }).buildchainRef,
    "v2-alpha",
  );
  assert.equal(
    resolveBuildchainChannel({ ...base, eventName: "push", gitRef: "refs/tags/v2.12.0-alpha.0" }).buildchainRef,
    "v2-alpha",
  );
});

test("stable release evidence selects the generic stable major", () => {
  for (const publishChannel of ["release", "major"]) {
    const result = resolveBuildchainChannel({ ...base, publishChannel, eventName: "workflow_dispatch" });
    assert.equal(result.channel, "stable");
    assert.equal(result.buildchainRef, "v2");
  }
  assert.equal(
    resolveBuildchainChannel({ ...base, eventName: "release", releasePrerelease: "false" }).buildchainRef,
    "v2",
  );
  assert.equal(
    resolveBuildchainChannel({ ...base, eventName: "push", gitRef: "refs/tags/v2.12.0" }).buildchainRef,
    "v2",
  );
});

test("explicit channel and runtime overrides take precedence with conflict checks", () => {
  assert.equal(resolveBuildchainChannel({ ...base, requestedChannel: "stable" }).buildchainRef, "v2");
  assert.equal(resolveBuildchainChannel({ ...base, requestedChannel: "alpha" }).buildchainRef, "v2-alpha");
  assert.equal(resolveBuildchainChannel({ ...base, requestedRef: "v2.12-alpha" }).channel, "alpha");
  assert.equal(
    resolveBuildchainChannel({ ...base, requestedRef: "train/v2/v2.3/channel-router" }).channel,
    "override",
  );
  assert.throws(
    () => resolveBuildchainChannel({ ...base, requestedChannel: "stable", requestedRef: "v2-alpha" }),
    /conflicts/,
  );
  assert.throws(
    () => resolveBuildchainChannel({ ...base, requestedChannel: "alpha", requestedRef: "a".repeat(40) }),
    /require buildchain-channel=auto/,
  );
});

test("ambiguous release-like intent fails closed", () => {
  assert.throws(
    () => resolveBuildchainChannel({ ...base, publishChannel: "preview", eventName: "workflow_dispatch" }),
    /requires an explicit buildchain-channel/,
  );
  assert.throws(
    () => resolveBuildchainChannel({ ...base, eventName: "release" }),
    /release events require/,
  );
  assert.throws(
    () => resolveBuildchainChannel({ ...base, eventName: "push", gitRef: "refs/tags/latest" }),
    /not a canonical semver release tag/,
  );
});

test("router remains generic across Buildchain majors", () => {
  const result = resolveBuildchainChannel({ routerRef: "v7-alpha", eventName: "pull_request" });
  assert.equal(result.major, 7);
  assert.equal(result.buildchainRef, "v7-alpha");
});

test("generated channel workflow mirrors the advanced build surface", () => {
  const source = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  const expected = generateChannelBuildWorkflow(source);
  const current = fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  assert.equal(current, expected);
  assert.match(current, /uses: \.\/\.github\/workflows\/\.build\.yml/);
  assert.match(current, /buildchain-ref: \$\{\{ needs\.resolve-channel\.outputs\.buildchain-ref \}\}/);
  assert.match(current, /buildchain-contract-lock-path: \$\{\{ needs\.resolve-channel\.outputs\.contract-lock-path \}\}/);
  assert.doesNotMatch(current, /uses: .*\$\{\{/);
});
