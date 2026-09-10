// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  resolveRendererPath,
  runCandidateBodyPrefixRenderer,
} from "../packages/core/governance/candidate/body-renderer.js";

function fixture(rendererSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-prefix-"));
  const consumerRoot = path.join(root, "consumer");
  fs.mkdirSync(path.join(consumerRoot, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(consumerRoot, "scripts", "render.mjs"),
    rendererSource,
  );
  childProcess.execFileSync("git", ["init", "-q"], { cwd: consumerRoot });
  childProcess.execFileSync("git", ["add", "."], { cwd: consumerRoot });
  childProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Buildchain Test",
      "-c",
      "user.email=buildchain-test@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: consumerRoot },
  );
  const selectedSha = childProcess
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: consumerRoot,
      encoding: "utf8",
    })
    .trim();
  return {
    root,
    consumerRoot,
    selectedSha,
    outputPath: path.join(root, "prefix.txt"),
    githubOutput: path.join(root, "github-output.txt"),
  };
}

function options(row) {
  return {
    ...row,
    renderer: "scripts/render.mjs",
    sourceBranch: "dev/v4/v4.0",
    targetBranch: "alpha/v4/v4.0",
  };
}

test("exact-source renderer emits a multiline prefix without credential environment", () => {
  const row = fixture(`
    import fs from "node:fs";
    const safe = !process.env.GITHUB_TOKEN && !process.env.ACTIONS_RUNTIME_TOKEN;
    fs.writeFileSync(process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT,
      "<!-- consumer-release\\n{\\\"safe\\\":" + safe + "}\\n-->");
  `);
  const prefix = runCandidateBodyPrefixRenderer({ ...options(row), environment: process.env });
  assert.match(prefix, /"safe":true/u);
  assert.match(prefix, /<!-- consumer-release/u);
  assert.equal(fs.existsSync(row.githubOutput), false);
});

test("renderer path and exact checkout identity fail closed", () => {
  const row = fixture(`
    import fs from "node:fs";
    fs.writeFileSync(process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT, "valid prefix");
  `);
  assert.throws(
    () => resolveRendererPath(row.consumerRoot, "../outside.mjs"),
    /inside the consumer checkout/u,
  );
  const outside = path.join(row.root, "outside.mjs");
  const link = path.join(row.consumerRoot, "scripts", "outside-link.mjs");
  fs.writeFileSync(outside, "export default true;\n");
  fs.symlinkSync(outside, link);
  assert.throws(
    () => resolveRendererPath(row.consumerRoot, "scripts/outside-link.mjs"),
    /inside the consumer checkout/u,
  );
  assert.throws(
    () =>
      runCandidateBodyPrefixRenderer({
        environment: process.env,
        ...options(row),
        selectedSha: "f".repeat(40),
      }),
    /does not match selected SHA/u,
  );
});

test("renderer failure and managed-marker injection never produce an output", () => {
  const failed = fixture(`throw new Error("synthetic renderer failure");`);
  assert.throws(
    () => runCandidateBodyPrefixRenderer({ ...options(failed), environment: process.env }),
    /synthetic renderer failure/u,
  );
  assert.equal(fs.existsSync(failed.githubOutput), false);

  const injected = fixture(`
    import fs from "node:fs";
    fs.writeFileSync(process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT,
      "<!-- buildchain-dev-alpha-candidate-state\\n{}\\n-->");
  `);
  assert.throws(
    () => runCandidateBodyPrefixRenderer({ ...options(injected), environment: process.env }),
    /managed candidate state marker/u,
  );
  assert.equal(fs.existsSync(injected.githubOutput), false);
});
