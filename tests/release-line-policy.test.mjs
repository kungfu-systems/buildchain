import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getBumpKeyword } from "../scripts/release-line-policy.mjs";

function withPackageVersion(version, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-bump-ref-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "@kungfu-systems/buildchain", version }, null, 2) + "\n",
  );
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("version-state alpha PRs are valid verify-only prerelease candidates", () => {
  withPackageVersion("1.0.5-alpha.1", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "buildchain/version-state/alpha-v1-v1.0/9b949937c31e",
        baseRef: "alpha/v1/v1.0",
      }),
      "prerelease",
    );
  });
});

test("version-state release PRs are valid verify-only release candidates", () => {
  withPackageVersion("1.0.5", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "buildchain/version-state/release-v1-v1.0/aaaaaaaaaaaa",
        baseRef: "release/v1/v1.0",
      }),
      "patch",
    );
  });
});

test("version-state publish-gate/major PRs are valid verify-only major release candidates", () => {
  withPackageVersion("2.0.0", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "buildchain/version-state/publish-gate-major/c249a32edecf",
        baseRef: "publish-gate/major",
      }),
      "patch",
    );
  });
});

test("legacy major-gate version-state PRs remain explicit compatibility aliases", () => {
  withPackageVersion("2.0.0", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "buildchain/version-state/major-gate/c249a32edecf",
        baseRef: "major-gate",
      }),
      "patch",
    );
  });
});

test("version-state PRs must target the same release line", () => {
  withPackageVersion("1.0.5-alpha.1", (cwd) => {
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "buildchain/version-state/alpha-v1-v1.0/9b949937c31e",
          baseRef: "alpha/v1/v1.1",
        }),
      /Versions not match/,
    );
  });
});

test("release to publish-gate/major is the only major bump channel", () => {
  withPackageVersion("1.0.5", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "release/v1/v1.0",
        baseRef: "publish-gate/major",
      }),
      "premajor",
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "main",
          baseRef: "main",
        }),
      /does not match current/,
    );
  });
});
