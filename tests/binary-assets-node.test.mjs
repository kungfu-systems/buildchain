import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import YAML from "yaml";
import { verifySourceRuntimeCheckouts } from "../packages/core/runtime/checkout-identity.js";
import { validateBinaryCapability } from "../packages/core/publication/binary/capability.js";
import { writeChecksums } from "../packages/core/build/binary/checksums.js";
const sha = "d".repeat(40),
  runtime = "e".repeat(40),
  digest = "a".repeat(64);
function evidence() {
  return {
    tag: "v4.1.0-alpha.0",
    sourceSha: sha,
    now: Date.parse("2026-09-09T00:00:00Z"),
    capability: {
      decision: "allow",
      workflowPath: ".github/workflows/.release-binary-assets.yml",
      capabilityIds: ["github-release"],
      environment: "buildchain-release-assets",
      channel: "release-assets",
      version: "4.1.0-alpha.0",
      sourceSha: sha,
      artifactDigest: digest,
      expiresAt: "2026-09-09T01:00:00Z",
    },
    manifest: {
      release: { sourceSha: sha, tag: "v4.1.0-alpha.0" },
      bundle: { sha256: digest },
    },
  };
}
test("binary authority binds exact source, bundle, publisher, environment and expiry", () => {
  assert.doesNotThrow(() => validateBinaryCapability(evidence()));
  for (const change of [
    { decision: "deny" },
    { workflowPath: ".github/workflows/other.yml" },
    { capabilityIds: [] },
    { environment: "other" },
    { channel: "stable" },
    { version: "4.1.0" },
    { sourceSha: "f".repeat(40) },
    { artifactDigest: "b".repeat(64) },
    { expiresAt: "invalid" },
    { expiresAt: "2026-09-08T00:00:00Z" },
  ]) {
    const value = evidence();
    Object.assign(value.capability, change);
    assert.throws(() => validateBinaryCapability(value));
  }
  assert.throws(
    () =>
      validateBinaryCapability({ ...evidence(), sourceSha: "f".repeat(40) }),
    /source mismatch/,
  );
  const changed = evidence();
  changed.manifest.release.tag = "v4.1.0";
  assert.throws(() => validateBinaryCapability(changed), /bundle tag mismatch/);
});
test("binary runtime and source checkout must both match admitted immutable identities", () => {
  const calls = [];
  verifySourceRuntimeCheckouts({ sourceDirectory: ".", runtimeDirectory: ".buildchain/runtime", runtimeSha: runtime, sourceSha: sha }, (_cmd, args) => {
    calls.push(args);
    return args[1] === "." ? sha : runtime;
  });
  assert.deepEqual(
    calls.map((args) => args[1]),
    [".buildchain/runtime", "."],
  );
  assert.throws(
    () =>
      verifySourceRuntimeCheckouts(
        { sourceDirectory: ".", runtimeDirectory: ".buildchain/runtime", runtimeSha: "v4-alpha", sourceSha: sha },
        () => runtime,
      ),
    /exact commit/,
  );
  assert.throws(
    () =>
      verifySourceRuntimeCheckouts(
        { sourceDirectory: ".", runtimeDirectory: ".buildchain/runtime", runtimeSha: runtime, sourceSha: sha },
        () => runtime,
      ),
    /Source does not match/,
  );
});
test("binary checksums cover sorted files once and replace the prior manifest atomically", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binary-node-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "checksums.txt"), "previous");
  fs.mkdirSync(path.join(directory, "subdirectory"));
  fs.writeFileSync(path.join(directory, "z archive.tgz"), "z");
  fs.writeFileSync(path.join(directory, "a.tgz"), "a");
  await writeChecksums(directory);
  const hash = (value) =>
    crypto.createHash("sha256").update(value).digest("hex");
  const expected = `${hash("a")}  ./a.tgz\n${hash("z")}  ./z archive.tgz\n`;
  assert.equal(
    fs.readFileSync(path.join(directory, "checksums.txt"), "utf8"),
    expected,
  );
  await writeChecksums(directory);
  assert.equal(
    fs.readFileSync(path.join(directory, "checksums.txt"), "utf8"),
    expected,
  );
  assert.equal(
    fs.readdirSync(directory).filter((x) => x.endsWith(".tmp")).length,
    0,
  );
  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(directory, "bad\nname"), "bad");
    await assert.rejects(() => writeChecksums(directory), /filename/);
    assert.equal(
      fs.readFileSync(path.join(directory, "checksums.txt"), "utf8"),
      expected,
    );
  }
});
test("binary publication retains protected environment and only immutable asset upload", () => {
  const load = (file) =>
    YAML.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  const workflow = load(".github/workflows/.release-binary-assets.yml");
  assert.equal(workflow.jobs.publish.environment, "buildchain-release-assets");
  assert.equal(workflow.jobs.publish.needs, "publication-authority");
  assert.deepEqual(workflow.jobs.publish.permissions, {
    actions: "read",
    contents: "write",
  });
  const action = load("actions/release/binary/publish/action.yml");
  assert.ok(
    action.runs.steps.find((s) =>
      s.uses?.endsWith("/publication/binary/publish"),
    ),
  );
  assert.ok(
    action.runs.steps.find((s) => s.uses?.endsWith("/source/verify-checkouts")),
  );
  assert.ok(action.runs.steps.every(step => step.uses && !step.run && !step.shell));
  const source = JSON.stringify(action);
  assert.doesNotMatch(source, /--clobber|startsWith\(/);
  assert.ok(
    action.runs.steps.findIndex(
      (s) => s.name === "Verify source and runtime coordinates",
    ) <
      action.runs.steps.findIndex((s) => s.uses?.endsWith("/runtime/environment/prepare")),
  );
});
