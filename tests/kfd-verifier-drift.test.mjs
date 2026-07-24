import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectGitHubReleasePassport } from "../packages/core/release-passport.js";

const kfdPackageRoot = path.dirname(
  fileURLToPath(import.meta.resolve("@kungfu-tech/kfd/package.json")),
);
const kfdBin = path.join(kfdPackageRoot, "bin", "kfd.mjs");

test("published KFD verifier accepts a Buildchain-owned release passport", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-kfd-drift-"));
  try {
    const assetsDir = path.join(cwd, "dist");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "buildchain.tar.gz"), "buildchain\n");
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "@kungfu-tech/buildchain", version: "2.14.2-alpha.1" }, null, 2)}\n`,
    );

    const collected = collectGitHubReleasePassport({
      cwd,
      tag: "v2.14.2-alpha.1",
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      line: "v2.14",
      assetsDir,
      outputDir: "release-passport",
    });
    assert.equal(collected.checkReport.ok, true);

    const result = spawnSync(
      process.execPath,
      [kfdBin, "verify", "passport", collected.outputDir, "--json"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true, result.stdout);
    assert.equal(
      report.profile,
      "buildchain.release-passport/v1-documented-subset",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
