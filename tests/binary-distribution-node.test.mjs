import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  binaryDistributionPreflight,
  binaryPassportOptions,
  checksumBinaryArtifacts,
} from "../packages/core/build/nodes/binary-distribution.mjs";
const env = {
  RELEASE_TAG: "v4.1.0-alpha.1",
  GITHUB_REF: "refs/tags/v4.1.0-alpha.1",
  GITHUB_SHA: "a".repeat(40),
  SOURCE_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "kungfu-systems/buildchain",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};
test("binary distribution rejects historical majors and mismatched dispatch refs before the build matrix", () => {
  binaryDistributionPreflight(env);
  assert.throws(
    () =>
      binaryDistributionPreflight({
        ...env,
        RELEASE_TAG: "v3.0.9",
        GITHUB_REF: "refs/tags/v3.0.9",
      }),
    /current v4/,
  );
  assert.throws(
    () =>
      binaryDistributionPreflight({
        ...env,
        GITHUB_REF: "refs/heads/dev/v4/v4.1",
      }),
    /exact release tag/,
  );
});
test("binary passport requires the exact settled version with no legacy base passport", () => {
  const options = binaryPassportOptions(env, () => ({
    publishedVersion: "4.1.0-alpha.1",
  }));
  assert.equal(options.packageVersion, "4.1.0-alpha.1");
  assert.equal(options.basePassportJson, undefined);
  assert.deepEqual(options.releaseEvidenceJsons, [
    ".buildchain/publication-evidence/buildchain-publication-settlement.json",
  ]);
  assert.equal(
    options.workflow.url,
    "https://github.com/kungfu-systems/buildchain/actions/runs/123",
  );
  assert.throws(
    () => binaryPassportOptions(env, () => ({ publishedVersion: "4.0.10" })),
    /must match/,
  );
  assert.throws(
    () =>
      binaryPassportOptions(env, () => {
        throw new Error("missing evidence");
      }),
    /missing evidence/,
  );
});
test("binary checksums retain span success and failure evidence without a shell pipeline", async (t) => {
  const previous = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "binary-checksum-node-"));
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  process.chdir(cwd);
  fs.mkdirSync("dist/binary", { recursive: true });
  fs.writeFileSync("dist/binary/a archive.tgz", "fixture");
  const input = { ...env, BUILDCHAIN_LOG_PATH: path.join(cwd, "events.jsonl") };
  await checksumBinaryArtifacts(input);
  assert.match(
    fs.readFileSync("dist/binary/checksums.txt", "utf8"),
    /^[0-9a-f]{64}  \.\/a archive.tgz\n$/,
  );
  fs.unlinkSync("dist/binary/a archive.tgz");
  await assert.rejects(checksumBinaryArtifacts(input), /contains no files/);
  const events = fs
    .readFileSync(input.BUILDCHAIN_LOG_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event);
  assert.deepEqual(events, [
    "release-passport.checksums.start",
    "release-passport.checksums.end",
    "release-passport.checksums.start",
    "release-passport.checksums.error",
  ]);
});
test("binary workflow has one current settlement path and preserves the dispatch authority boundary", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      ".github/workflows/self-build-binary-distribution.yml",
      "utf8",
    ),
  );
  assert.equal(
    workflow.on.workflow_dispatch.inputs["upload-release"],
    undefined,
  );
  assert.equal(workflow.jobs.binary.needs, "preflight");
  assert.deepEqual(workflow.jobs.passport.permissions, { contents: "read" });
  assert.equal(
    workflow.jobs["dispatch-publication"].permissions.actions,
    "write",
  );
  const passport = YAML.parse(
    fs.readFileSync(
      "actions/build/binary-distribution-passport/action.yml",
      "utf8",
    ),
  );
  const evidence = passport.runs.steps.find(
    (s) => s.name === "Read exact publication settlement",
  );
  assert.ok(evidence);
  assert.equal(evidence.if, undefined);
  assert.equal(
    passport.runs.steps.some((s) => s.id === "fetch-durable-release-state"),
    false,
  );
});
