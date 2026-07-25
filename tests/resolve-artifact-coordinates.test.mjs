import assert from "node:assert/strict";
import test from "node:test";

import { resolveArtifactCoordinates } from "../scripts/resolve-artifact-coordinates.mjs";

const SOURCE_SHA = "a".repeat(40);

function liveArtifact(id, name, digestCharacter) {
  return {
    id,
    name,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    expired: false,
    expires_at: "2026-08-08T12:00:00Z",
  };
}

function options() {
  return {
    artifacts: [
      liveArtifact(101, `product-linux-x64-${SOURCE_SHA}`, "b"),
      liveArtifact(102, `product-macos-arm64-${SOURCE_SHA}`, "c"),
    ],
    platforms: [
      { id: "macos-arm64", name: "macOS ARM64" },
      { id: "linux-x64", name: "Linux x64" },
    ],
    artifactName: "product",
    artifactNameTemplate: "{artifact}-{platform}-{sha}",
    sourceSha: SOURCE_SHA,
    repository: "example/product",
    runId: "42",
    runAttempt: "1",
    serverUrl: "https://github.com",
  };
}

test("resolves a producer-owned exact coordinate for every platform", () => {
  const result = resolveArtifactCoordinates(options());
  assert.equal(result.schema, "buildchain.github-artifact-coordinate-set/v1");
  assert.deepEqual(
    result.artifacts.map(({ platformId }) => platformId),
    ["linux-x64", "macos-arm64"],
  );
  assert.equal(
    result.artifacts[0].url,
    "https://github.com/example/product/actions/runs/42/artifacts/101",
  );
});

test("supports the declared artifact name template contract", () => {
  const value = options();
  value.artifactNameTemplate =
    "{artifact}-{shortSha}-{platformId}-{runId}-{runAttempt}";
  value.artifacts = [
    liveArtifact(101, `product-${SOURCE_SHA.slice(0, 12)}-linux-x64-42-1`, "b"),
    liveArtifact(
      102,
      `product-${SOURCE_SHA.slice(0, 12)}-macos-arm64-42-1`,
      "c",
    ),
  ];
  assert.equal(resolveArtifactCoordinates(value).artifacts.length, 2);
});

test("fails closed on missing, duplicate, or digestless expected artifacts", () => {
  const missing = options();
  missing.artifacts = missing.artifacts.slice(1);
  assert.throws(
    () => resolveArtifactCoordinates(missing),
    /expected exactly one live artifact named product-linux-x64/u,
  );

  const duplicate = options();
  duplicate.artifacts.push({ ...duplicate.artifacts[0], id: 999 });
  assert.throws(
    () => resolveArtifactCoordinates(duplicate),
    /expected exactly one live artifact named product-linux-x64/u,
  );

  const digestless = options();
  digestless.artifacts[0].digest = "";
  assert.throws(
    () => resolveArtifactCoordinates(digestless),
    /has no exact digest/u,
  );
});
