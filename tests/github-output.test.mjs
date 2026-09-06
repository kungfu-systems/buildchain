import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeGitHubOutputs } from "../scripts/build-contract-core.mjs";

test("writeGitHubOutputs preserves single-line and multiline values", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-output-"),
  );
  const outputPath = path.join(workspace, "github-output.txt");
  const previousOutput = process.env.GITHUB_OUTPUT;
  try {
    process.env.GITHUB_OUTPUT = outputPath;
    writeGitHubOutputs({
      plain: "one",
      "release-assets": "dist/linux\ndist/macos\ndist/windows",
      "trailing-release-assets": "dist/linux\ndist/macos\n",
    });

    const output = fs.readFileSync(outputPath, "utf8");
    assert.match(output, /^plain=one$/mu);
    const match = output.match(
      /^release-assets<<(BUILDCHAIN_OUTPUT_[0-9a-f]{64})\n([\s\S]+)\n\1$/mu,
    );
    assert.ok(match);
    assert.equal(match[2], "dist/linux\ndist/macos\ndist/windows");
    const trailing = output.match(
      /^trailing-release-assets<<(BUILDCHAIN_OUTPUT_[0-9a-f]{64})\n([\s\S]+)\n\1$/mu,
    );
    assert.equal(trailing?.[2], "dist/linux\ndist/macos");
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
