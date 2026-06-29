import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPackageManager,
  commandForKungfuUpgrade,
  commandForRunScript,
  commandForVersion,
  detectPackageManager,
  getCurrentLockInfo,
  getPnpmLockInfo,
  getWorkspaceInfo,
  getYarnLockInfo,
} from "../packages/core/package-manager.js";

function withTempRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-pm-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("detectPackageManager prefers packageManager over lockfiles", () => {
  withTempRepo(
    {
      "package.json": JSON.stringify({ packageManager: "pnpm@11.7.0" }),
      "yarn.lock": "",
    },
    (dir) => {
      assert.deepEqual(detectPackageManager(dir), {
        name: "pnpm",
        reason: "packageManager",
        packageManager: "pnpm@11.7.0",
      });
    },
  );
});

test("detectPackageManager fails closed without an explicit manager signal", () => {
  withTempRepo({ "package.json": JSON.stringify({ name: "missing-manager" }) }, (dir) => {
    assert.throws(
      () => detectPackageManager(dir),
      /Add packageManager to package\.json or commit a supported lockfile/,
    );
  });
});

test("commands are generated for pnpm, yarn, and npm", () => {
  assert.equal(assertPackageManager("pnpm"), "pnpm");
  assert.throws(() => commandForRunScript("bun", "format"), /Unsupported package manager: bun/);
  assert.deepEqual(commandForRunScript("pnpm", "format"), { cmd: "pnpm", args: ["run", "format"] });
  assert.deepEqual(commandForRunScript("npm", "format"), { cmd: "npm", args: ["run", "format"] });
  assert.deepEqual(commandForVersion("yarn", "patch", { preid: "alpha", message: "Release", tag: false }), {
    cmd: "yarn",
    args: ["version", "--patch", "--preid", "alpha", "--message", "Release", "--no-git-tag-version"],
  });
  assert.deepEqual(commandForVersion("pnpm", "patch", { preid: "alpha", message: "Release", tag: false }), {
    cmd: "pnpm",
    args: ["version", "patch", "--preid", "alpha", "--message", "Release", "--no-git-tag-version"],
  });
  assert.equal(commandForKungfuUpgrade("pnpm").primary, 'pnpm update --recursive --filter "@kungfu-trader/*" --ignore-scripts');
});

test("workspace info is parsed without yarn workspaces info", () => {
  withTempRepo(
    {
      "package.json": JSON.stringify({}),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": JSON.stringify({ name: "@kungfu-trader/a" }),
      "packages/b/package.json": JSON.stringify({ name: "@kungfu-trader/b" }),
    },
    (dir) => {
      assert.deepEqual(getWorkspaceInfo(dir), {
        "@kungfu-trader/a": { location: "packages/a" },
        "@kungfu-trader/b": { location: "packages/b" },
      });
    },
  );
});

test("pnpm, yarn, and npm lockfiles expose kungfu package versions", () => {
  const pnpmInfo = getPnpmLockInfo(`
packages:
  /@kungfu-trader/core@3.1.0:
    resolution: {}
  /left-pad@1.3.0:
    resolution: {}
`);
  assert.equal(pnpmInfo.get("@kungfu-trader/core"), "3.1.0");
  assert.equal(pnpmInfo.has("left-pad"), false);

  const yarnInfo = getYarnLockInfo(`
"@kungfu-trader/core@^3.1.0":
  version "3.1.1"
  resolved "https://example.invalid/core.tgz"

left-pad@^1.3.0:
  version "1.3.0"
`);
  assert.equal(yarnInfo.get("@kungfu-trader/core"), "3.1.1");
  assert.equal(yarnInfo.has("left-pad"), false);

  withTempRepo(
    {
      "package-lock.json": JSON.stringify({
        packages: {
          "node_modules/@kungfu-trader/core": { version: "3.2.0" },
        },
      }),
    },
    (dir) => {
      assert.equal(getCurrentLockInfo(dir).get("@kungfu-trader/core"), "3.2.0");
    },
  );
});
