import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getBumpKeyword } from "../packages/core/release/commands/release-line-policy.mjs";

function withPackageVersion(version, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-bump-ref-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "@kungfu-tech/buildchain", version }, null, 2) + "\n",
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

test("publish-gate alpha PRs are valid verify-only prerelease candidates", () => {
  withPackageVersion("1.0.5-alpha.1", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "publish-gate/alpha/v1/v1.0/1.0.5-alpha.1",
        baseRef: "alpha/v1/v1.0",
      }),
      "prerelease",
    );
  });
});

test("publish-gate release PRs are valid verify-only release candidates", () => {
  withPackageVersion("1.0.5", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "publish-gate/release/v1/v1.0/1.0.5",
        baseRef: "release/v1/v1.0",
      }),
      "patch",
    );
  });
});

test("dev PRs promote the same version line to a protected authority without a version bump", () => {
  withPackageVersion("3.0.0-alpha.0", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "dev/v3/v3.0",
        baseRef: "authority/v3/v3.0/artifact-signing",
      }),
      "none",
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "dev/v3/v3.1",
          baseRef: "authority/v3/v3.0/artifact-signing",
        }),
      /Versions not match/,
    );
  });
});

test("publish-gate PRs must target the same channel release line", () => {
  withPackageVersion("1.0.5", (cwd) => {
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "publish-gate/release/v1/v1.0/1.0.5",
          baseRef: "release/v1/v1.1",
        }),
      /Versions not match/,
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "publish-gate/release/v1/v1.0/1.0.5",
          baseRef: "alpha/v1/v1.0",
        }),
      /Versions not match/,
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

test("retired major-gate version-state aliases cannot authorize a release", () => {
  withPackageVersion("2.0.0", (cwd) => {
    assert.throws(() => getBumpKeyword({ cwd,
      headRef: "buildchain/version-state/major-gate/c249a32edecf", baseRef: "major-gate",
    }), /Versions not match/);
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

test("release-line recovery PRs are valid only for the same release line", () => {
  withPackageVersion("2.0.13", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "fix/release-line-v2-v2.0-finalization-recovery",
        baseRef: "release/v2/v2.0",
      }),
      "patch",
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "fix/release-line-v2-v2.0-finalization-recovery",
          baseRef: "release/v2/v2.1",
        }),
      /Versions not match/,
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "fix/release-line-finalization-recovery",
          baseRef: "release/v2/v2.0",
        }),
      /Versions not match/,
    );
  });
});

test("alpha-line recovery PRs are valid only for the same alpha line", () => {
  withPackageVersion("4.0.1-alpha.42", (cwd) => {
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: "fix/alpha-line-v4-v4.0-wave4-reconciliation",
        baseRef: "alpha/v4/v4.0",
      }),
      "prerelease",
    );
    assert.throws(
      () =>
        getBumpKeyword({
          cwd,
          headRef: "fix/alpha-line-v4-v4.0-wave4-reconciliation",
          baseRef: "release/v4/v4.0",
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

test("generated product PRs retain exact channel and package line verification", () => {
  const headRef =
    "chore/v4-product-pr/release-v4-v4.0/e493d3550af5-29a053e8547b-688eb18594bc";
  withPackageVersion("4.0.4", (cwd) => {
    assert.equal(
      getBumpKeyword({ cwd, headRef, baseRef: "release/v4/v4.0" }),
      "patch",
    );
    for (const baseRef of [
      "release/v4/v4.1",
      "alpha/v4/v4.0",
      "release/v3/v3.0",
    ])
      assert.throws(
        () => getBumpKeyword({ cwd, headRef, baseRef }),
        /Versions not match/,
      );
    for (const bad of [
      headRef + "/extra",
      headRef.replace("688eb18594bc", "not-a-hash"),
      headRef.replace("chore/v4-product-pr", "feature/v4-product-pr"),
    ])
      assert.throws(() =>
        getBumpKeyword({ cwd, headRef: bad, baseRef: "release/v4/v4.0" }),
      );
  });
  withPackageVersion("4.1.4", (cwd) =>
    assert.throws(
      () => getBumpKeyword({ cwd, headRef, baseRef: "release/v4/v4.0" }),
      /does not match current/,
    ),
  );
  withPackageVersion("4.0.4-alpha.0", (cwd) =>
    assert.equal(
      getBumpKeyword({
        cwd,
        headRef: headRef.replace("release-v4", "alpha-v4"),
        baseRef: "alpha/v4/v4.0",
      }),
      "prerelease",
    ),
  );
});
