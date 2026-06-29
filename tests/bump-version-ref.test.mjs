import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getBumpKeyword } from "../actions/bump-version/lib.js";

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
