import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCKED_SOURCE_CHECKOUT_CONTRACT,
  lockedSourceCheckout,
} from "../scripts/locked-source-checkout.mjs";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-origin-"));
  git(["init"], root);
  git(["config", "user.name", "Buildchain Test"], root);
  git(["config", "user.email", "buildchain@example.test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "README.md"], root);
  git(["commit", "-m", "initial"], root);
  const sha = git(["rev-parse", "HEAD"], root);
  const tree = git(["rev-parse", "HEAD^{tree}"], root);
  const bare = `${root}.git`;
  git(["clone", "--bare", root, bare], path.dirname(root));
  return { root, bare, sha, tree };
}

test("locked source checkout uses a mirror cache and verifies head and tree", () => {
  const origin = createRepository();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-work-"));
  const evidence = lockedSourceCheckout({
    workspace,
    repository: "kungfu-systems/example",
    sourceSha: origin.sha,
    sourceTreeSha: origin.tree,
    mode: "require",
    mirrorUrlTemplate: `file://${origin.bare}`,
    fallback: "fail",
    diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
    now: () => "2026-07-07T00:00:00.000Z",
  });
  assert.equal(evidence.contract, LOCKED_SOURCE_CHECKOUT_CONTRACT);
  assert.equal(evidence.cache.hit, true);
  assert.equal(evidence.cache.transport, "mirror-url");
  assert.equal(evidence.verification.head, origin.sha);
  assert.equal(evidence.verification.tree, origin.tree);
  assert.equal(git(["rev-parse", "HEAD"], workspace), origin.sha);
  const persisted = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/diagnostics/source-checkout.json"), "utf8"));
  assert.equal(persisted.cache.hit, true);
});

test("locked source checkout auto mode falls back to GitHub transport", () => {
  const origin = createRepository();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-fallback-"));
  const evidence = lockedSourceCheckout({
    workspace,
    repository: "kungfu-systems/example",
    sourceSha: origin.sha,
    sourceTreeSha: origin.tree,
    mode: "auto",
    mirrorUrlTemplate: "file:///does/not/exist/{repositorySlug}.git",
    fallback: "github",
    githubRemote: `file://${origin.bare}`,
    diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
  });
  assert.equal(evidence.cache.hit, false);
  assert.equal(evidence.cache.fallbackUsed, true);
  assert.equal(evidence.cache.transport, "github");
  assert.match(evidence.cache.fallbackReason, /does not appear to be a git repository|not exist|failed/i);
  assert.equal(evidence.verification.headOk, true);
  assert.equal(evidence.verification.treeOk, true);
});

test("locked source checkout require mode fails before fallback when cache is unavailable", () => {
  const origin = createRepository();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-required-"));
  assert.throws(
    () => lockedSourceCheckout({
      workspace,
      repository: "kungfu-systems/example",
      sourceSha: origin.sha,
      sourceTreeSha: origin.tree,
      mode: "require",
      mirrorUrlTemplate: "file:///does/not/exist/{repositorySlug}.git",
      fallback: "github",
      githubRemote: `file://${origin.bare}`,
      diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
    }),
    /cache unavailable/,
  );
  const persisted = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/diagnostics/source-checkout.json"), "utf8"));
  assert.equal(persisted.cache.hit, false);
  assert.equal(persisted.cache.fallbackUsed, false);
  assert.equal(persisted.verification.headOk, false);
});

test("locked source checkout can use a runner-local reference repository without fetching", () => {
  const origin = createRepository();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-reference-"));
  const evidence = lockedSourceCheckout({
    workspace,
    repository: "kungfu-systems/example",
    sourceSha: origin.sha,
    sourceTreeSha: origin.tree,
    mode: "require",
    referenceRepositoryTemplate: origin.bare,
    fallback: "fail",
    diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
  });
  assert.equal(evidence.cache.hit, true);
  assert.equal(evidence.cache.transport, "reference-repository");
  assert.equal(evidence.cache.referenceAvailable, true);
  assert.equal(evidence.verification.head, origin.sha);
});
