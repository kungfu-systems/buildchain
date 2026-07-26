import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const currentImpact = JSON.parse(fs.readFileSync(path.join(root, ".buildchain/release-impact.json"), "utf8"));

function checkImpact(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-impact-contract-"));
  const impactPath = path.join(dir, "release-impact.json");
  fs.writeFileSync(impactPath, `${JSON.stringify({ ...currentImpact, ...overrides }, null, 2)}\n`);
  return spawnSync(process.execPath, ["scripts/check-inventory.mjs"], {
    cwd: root,
    env: { ...process.env, BUILDCHAIN_SELF_RELEASE_IMPACT_PATH: impactPath },
    encoding: "utf8",
  });
}

test("self release impact binds version, line, and summary semantics", () => {
  const result = checkImpact();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /buildchain inventory check passed/);
});

test("self release impact rejects a stale summary line", () => {
  const result = checkImpact({ summary: "Buildchain v2.14 stabilizes the release control plane." });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /summary must describe the current v3\.0 line/);
});

test("self release impact rejects a release line that disagrees with its version", () => {
  const result = checkImpact({
    release: { version: currentImpact.release.version, line: "v2.14" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /line must be v3\.0/);
});
