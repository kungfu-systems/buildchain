import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeReleaseLineBootstrapVersionState } from "../packages/core/release-line-bootstrap.js";

test("release-line bootstrap relines version-bound release impact text", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-line-bootstrap-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".buildchain"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "3.0.9" }, null, 2)}\n`,
  );
  const currentImpact = {
    release: { version: "3.0.9", line: "v3.0" },
    versionImpact: {
      final: "minor",
      rationale: "Buildchain v3.0 adds governed architecture contracts.",
    },
    summary: "Buildchain v3.0 extends release governance.",
  };
  fs.writeFileSync(
    path.join(cwd, ".buildchain", "release-impact.json"),
    `${JSON.stringify(currentImpact, null, 2)}\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd });

  writeReleaseLineBootstrapVersionState({
    cwd,
    major: 4,
    minor: 0,
    runVersionStateLifecycle: false,
  });
  const updated = JSON.parse(
    fs.readFileSync(path.join(cwd, ".buildchain", "release-impact.json"), "utf8"),
  );

  assert.deepEqual(updated.release, {
    version: "4.0.0-alpha.0",
    line: "v4.0",
  });
  assert.equal(
    updated.versionImpact.rationale,
    "Buildchain v4.0 adds governed architecture contracts.",
  );
  assert.equal(updated.summary, "Buildchain v4.0 extends release governance.");
  assert.equal(currentImpact.release.line, "v3.0");
});
