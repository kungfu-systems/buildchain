import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { verifyVersionStateDelta } from "../scripts/verify-version-state-delta.mjs";
import { planVersionProjection } from "../scripts/source-verification-evidence.mjs";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delta-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const write = (file, source) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), source);
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  // Per-command fixture identity never modifies a user's Git configuration.
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  for (const file of [
    "buildchain-config.js",
    "buildchain-layout.js",
    "spawn-command.js",
  ])
    write(
      `packages/core/${file}`,
      fs.readFileSync(new URL(`../packages/core/${file}`, import.meta.url)),
    );
  write("package.json", '{"type":"module","version":"4.0.2-alpha.34"}\n');
  write(
    ".buildchain/buildchain.toml",
    `schema = 1
[version]
required = true
derived_files = ["dist/site/site-manifest.json"]
[[version.files]]
type = "json"
path = "package.json"
key = "version"
[lifecycle.verify]
command = "node --check scripts/generate-site-bundle.mjs"
[lifecycle.version-state]
command = "node scripts/generate-site-bundle.mjs"
`,
  );
  write("dist/site/site-manifest.json", "{}\n");
  write(
    "scripts/generate-site-bundle.mjs",
    `import fs from 'node:fs';
const version = JSON.parse(fs.readFileSync('package.json')).version;
const generatedAt = process.env.BUILDCHAIN_SITE_GENERATED_AT;
fs.writeFileSync('dist/site/site-manifest.json', JSON.stringify({ package: {version}, sourceRevision: process.env.BUILDCHAIN_SOURCE_SHA, generatedAt, publishedAt: generatedAt }) + '\\n');
`,
  );
  const baseSha = commit();
  write(
    "package.json",
    JSON.stringify({ type: "module", version: "4.0.2-alpha.35" }, null, 2) +
      "\n",
  );
  const manifest = {
    package: { version: "4.0.2-alpha.35" },
    sourceRevision: baseSha,
    generatedAt: "2026-09-05T00:00:00.000Z",
    publishedAt: "2026-09-05T00:00:00.000Z",
  };
  write("dist/site/site-manifest.json", JSON.stringify(manifest) + "\n");
  return {
    cwd,
    write,
    git,
    commit,
    baseSha,
    manifest,
    headSha: commit(),
    nodeModules: path.resolve("node_modules"),
  };
}

test("version-only delta regenerates all declared outputs from the exact base", (t) => {
  const f = fixture(t);
  assert.equal(verifyVersionStateDelta(f).version, "4.0.2-alpha.35");
  assert.throws(
    () => verifyVersionStateDelta({ ...f, baseSha: "HEAD" }),
    /exact commits/u,
  );
  f.write(
    "package.json",
    JSON.stringify(
      { type: "module", version: "4.0.2-alpha.35", scripts: { check: "true" } },
      null,
      2,
    ) + "\n",
  );
  assert.throws(
    () => verifyVersionStateDelta({ ...f, headSha: f.commit() }),
    /regeneration mismatch/u,
  );
});

test("undeclared source, dependency, deletion and metadata changes cannot become projections", (t) => {
  const f = fixture(t);
  f.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  assert.throws(
    () => verifyVersionStateDelta({ ...f, headSha: f.commit() }),
    /undeclared/u,
  );
  f.write(
    "dist/site/site-manifest.json",
    JSON.stringify({ ...f.manifest, sourceRevision: "a".repeat(40) }) + "\n",
  );
  assert.throws(() =>
    verifyVersionStateDelta({ ...f, baseSha: f.headSha, headSha: f.commit() }),
  );
  f.git("rm", "package.json");
  assert.throws(
    () => verifyVersionStateDelta({ ...f, headSha: f.commit() }),
    /undeclared/u,
  );
});

test("differential verification requires full base proof and cannot reseal a projection", async () => {
  let regenerated = false;
  const request = {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    discover: async () => ({ decision: "execute" }),
    regenerate: async () => {
      regenerated = true;
      return { validationKind: "version-state-projection" };
    },
  };
  assert.equal((await planVersionProjection(request)).decision, "execute");
  assert.equal(regenerated, false);
  const projected = await planVersionProjection({
    ...request,
    discover: async () => ({ decision: "reuse", evidenceRoot: "original" }),
  });
  assert.equal(projected.decision, "projection");
  assert.equal(projected.evidenceRoot, "original");
  await assert.rejects(
    planVersionProjection({
      ...request,
      discover: async () => ({ decision: "reuse" }),
      regenerate: async () => {
        throw new Error("tampered derived digest");
      },
    }),
  );
});

test("generated v4 projections never impersonate protected full source check names", async () => {
  const { createGeneratedVersionStateChecks } =
    await import("../actions/promote-buildchain-ref/lib.js");
  for (const [branch, expected] of [
    ["dev/v4/v4.0", "Version-state projection / check"],
    ["alpha/v3/v3.0", "check"],
  ]) {
    const checks = [];
    const names = await createGeneratedVersionStateChecks({
      octokit: {
        rest: { checks: { create: async (value) => checks.push(value) } },
      },
      owner: "owner",
      repo: "repo",
      branch,
      branchSha: "a".repeat(40),
      currentSha: "b".repeat(40),
      requiredStatusCheck: "check",
    });
    assert.deepEqual(names, [expected]);
    assert.deepEqual(
      checks.map((check) => check.name),
      [expected],
    );
  }
});
