import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  admitBinaryDistribution,
  binaryPassportOptions,
} from "../packages/core/build/binary/distribution.js";
import { writeChecksums } from "../packages/core/build/binary/checksums.js";
import { createBuildchainLogger } from "../packages/core/observability/logging.js";
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
  admitBinaryDistribution({ tag: env.RELEASE_TAG, ref: env.GITHUB_REF, sourceSha: env.GITHUB_SHA });
  assert.throws(
    () =>
      admitBinaryDistribution({
        sourceSha: env.GITHUB_SHA,
        tag: "v3.0.9",
        ref: "refs/tags/v3.0.9",
      }),
    /current v4/,
  );
  assert.throws(
    () =>
      admitBinaryDistribution({
        sourceSha: env.GITHUB_SHA, tag: env.RELEASE_TAG,
        ref: "refs/heads/dev/v4/v4.1",
      }),
    /exact release tag/,
  );
});
test("binary passport requires exact settled version and binds the settlement file", t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "binary-passport-")); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, ".buildchain/publication-evidence"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "release.json"); fs.writeFileSync(file, JSON.stringify({ publishedVersion: "4.1.0-alpha.1" }));
  const input = { workspace, tag: env.RELEASE_TAG, sourceSha: env.SOURCE_SHA, repository: env.GITHUB_REPOSITORY, workflow: { url: "https://github.com/kungfu-systems/buildchain/actions/runs/123" } };
  const options = binaryPassportOptions(input); assert.equal(options.packageVersion, "4.1.0-alpha.1"); assert.equal(options.basePassportJson, undefined);
  assert.deepEqual(options.releaseEvidenceJsons, [path.join(directory, "buildchain-publication-settlement.json")]); assert.equal(options.workflow.url, input.workflow.url);
  fs.writeFileSync(file, JSON.stringify({ publishedVersion: "4.0.10" })); assert.throws(() => binaryPassportOptions(input), /must match/);
  fs.unlinkSync(file); assert.throws(() => binaryPassportOptions(input), /ENOENT/);
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
  const logger = createBuildchainLogger({ cwd, path: input.BUILDCHAIN_LOG_PATH, source: "buildchain", component: "workflow", phase: "passport" });
  const checksum = () => logger.span("release-passport.checksums", {}, () => writeChecksums("dist/binary"));
  await checksum();
  assert.match(
    fs.readFileSync("dist/binary/checksums.txt", "utf8"),
    /^[0-9a-f]{64}  \.\/a archive.tgz\n$/,
  );
  fs.unlinkSync("dist/binary/a archive.tgz");
  await assert.rejects(checksum(), /contains no files/);
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
  assert.deepEqual(workflow.jobs.binary.needs, ["preflight", "execution-runtime"]);
  assert.deepEqual(workflow.jobs.passport.permissions, { contents: "read" });
  assert.equal(
    workflow.jobs["dispatch-publication"].permissions.actions,
    "write",
  );
  const passport = YAML.parse(
    fs.readFileSync(
      "actions/build/binary/passport/action.yml",
      "utf8",
    ),
  );
  const evidence = passport.runs.steps.find(
    (s) => s.uses === "./.buildchain/runtime/actions/build/binary/qualify",
  );
  assert.ok(evidence);
  assert.equal(evidence.if, undefined);
  assert.equal(
    passport.runs.steps.some((s) => s.id === "fetch-durable-release-state"),
    false,
  );
});
