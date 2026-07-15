import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCKED_SOURCE_CHECKOUT_CONTRACT,
  ISOLATED_GIT_GLOBAL_CONFIG,
  fetchSourceCommit,
  runBoundedFetch,
  lockedSourceCheckout,
} from "../scripts/locked-source-checkout.mjs";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(content = "hello\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-origin-"));
  git(["init"], root);
  git(["config", "user.name", "Buildchain Test"], root);
  git(["config", "user.email", "buildchain@example.test"], root);
  fs.writeFileSync(path.join(root, "README.md"), content);
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
  const configEnv = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const previous = new Map(configEnv.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  let evidence;
  try {
    evidence = lockedSourceCheckout({
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
  } finally {
    for (const key of configEnv) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(evidence.contract, LOCKED_SOURCE_CHECKOUT_CONTRACT);
  assert.equal(evidence.cache.hit, true);
  assert.equal(evidence.cache.transport, "mirror-url");
  assert.equal(evidence.verification.head, origin.sha);
  assert.equal(evidence.verification.tree, origin.tree);
  assert.equal(git(["rev-parse", "HEAD"], workspace), origin.sha);
  assert.equal(fs.readFileSync(path.join(workspace, "README.md"), "utf8"), "hello\n");
  const persisted = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/diagnostics/source-checkout.json"), "utf8"));
  assert.equal(persisted.cache.hit, true);
});

test("locked checkout CLI can bootstrap a nested Buildchain runtime from the mirror", () => {
  const origin = createRepository();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-runtime-checkout-work-"));
  const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "locked-source-checkout.mjs");

  execFileSync(process.execPath, [scriptPath], {
    cwd: workspace,
    env: {
      ...process.env,
      BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/buildchain",
      BUILDCHAIN_SOURCE_SHA: origin.sha,
      BUILDCHAIN_SOURCE_REF: "refs/heads/train/v2/v2.3/runtime-checkout-cache",
      BUILDCHAIN_SOURCE_TREE_SHA: origin.tree,
      BUILDCHAIN_SOURCE_CHECKOUT_PATH: ".buildchain/runtime",
      BUILDCHAIN_CHECKOUT_CACHE_MODE: "require",
      BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE: `file://${origin.bare}`,
      BUILDCHAIN_CHECKOUT_CACHE_FALLBACK: "fail",
      BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: ".buildchain/diagnostics/runtime-checkout.json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(git(["rev-parse", "HEAD"], path.join(workspace, ".buildchain", "runtime")), origin.sha);
  const evidence = JSON.parse(fs.readFileSync(
    path.join(workspace, ".buildchain", "diagnostics", "runtime-checkout.json"),
    "utf8",
  ));
  assert.equal(evidence.repository, "kungfu-systems/buildchain");
  assert.equal(evidence.checkoutPath, ".buildchain/runtime");
  assert.equal(evidence.cache.transport, "mirror-url");
  assert.equal(evidence.verification.headOk, true);
  assert.equal(evidence.verification.treeOk, true);
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
    githubTimeoutSeconds: 600,
    githubRemote: `file://${origin.bare}`,
    diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
  });
  assert.equal(evidence.cache.hit, false);
  assert.equal(evidence.cache.fallbackUsed, true);
  assert.equal(evidence.cache.transport, "github");
  assert.equal(evidence.policy.fetchAttempts, 3);
  assert.equal(evidence.policy.githubTimeoutSeconds, 600);
  assert.equal(evidence.cache.githubFetchAttempts, 1);
  assert.match(evidence.cache.fallbackReason, /does not appear to be a git repository|not exist|failed/i);
  assert.equal(evidence.verification.headOk, true);
  assert.equal(evidence.verification.treeOk, true);
});

test("locked fallback fetch is immune to a stale runner-global bundle rewrite", () => {
  const origin = createRepository();
  const stale = createRepository("stale bundle\n");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-checkout-isolated-"));
  const config = path.join(workspace, "runner-global.gitconfig");
  fs.writeFileSync(config, "");
  git([
    "config",
    "--file",
    config,
    "--add",
    `url.file://${stale.bare}.insteadOf`,
    `file://${origin.bare}`,
  ], workspace);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  let evidence;
  try {
    evidence = lockedSourceCheckout({
      workspace,
      repository: "kungfu-systems/example",
      sourceSha: origin.sha,
      sourceTreeSha: origin.tree,
      mode: "off",
      githubRemote: `file://${origin.bare}`,
      diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
    });
  } finally {
    if (previous == null) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  assert.equal(evidence.verification.head, origin.sha);
  assert.notEqual(evidence.verification.head, stale.sha);
});

test("source fetch seeds from the advertised ref before trying a raw SHA", () => {
  const calls = [];
  let containsCommit = false;
  const result = fetchSourceCommit({
    targetPath: "/tmp/buildchain-source-fetch-fixture",
    remoteName: "origin",
    remoteUrl: "https://github.com/kungfu-systems/example.git",
    sha: "a".repeat(40),
    fetchRef: "refs/heads/dev/v4/v4.0",
    timeoutMs: 600000,
    runGit: (args) => {
      calls.push(args);
      if (args[0] === "fetch" && args.at(-1).endsWith(":refs/buildchain/source-ref")) {
        containsCommit = true;
      }
    },
    containsCommit: () => containsCommit,
  });
  const fetches = calls.filter((args) => args[0] === "fetch");
  assert.equal(result.selector, "ref");
  assert.equal(result.checkoutSha, "a".repeat(40));
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].at(-1), "+refs/heads/dev/v4/v4.0:refs/buildchain/source-ref");
});

test("pull merge fetch accepts a regenerated commit only when the locked tree matches", () => {
  const calls = [];
  const expectedSha = "a".repeat(40);
  const regeneratedSha = "b".repeat(40);
  const sourceTreeSha = "c".repeat(40);
  const result = fetchSourceCommit({
    targetPath: "/tmp/buildchain-pull-merge-fetch-fixture",
    remoteName: "origin",
    remoteUrl: "https://github.com/kungfu-systems/example.git",
    sha: expectedSha,
    fetchRef: "refs/pull/629/merge",
    sourceTreeSha,
    timeoutMs: 600000,
    runGit: (args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1].endsWith("^{commit}")) return regeneratedSha;
      if (args[0] === "rev-parse" && args[1].endsWith("^{tree}")) return sourceTreeSha;
      return "";
    },
    containsCommit: () => false,
  });
  const fetches = calls.filter((args) => args[0] === "fetch");
  assert.equal(result.selector, "ref-tree");
  assert.equal(result.checkoutSha, regeneratedSha);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].at(-1), "+refs/pull/629/merge:refs/buildchain/source-ref");
});

test("source fetch preserves stderr for retry classification and diagnostics", () => {
  const calls = [];
  fetchSourceCommit({
    targetPath: "/tmp/buildchain-source-fetch-diagnostics-fixture",
    remoteName: "origin",
    remoteUrl: "https://github.com/kungfu-systems/example.git",
    sha: "a".repeat(40),
    fetchRef: "refs/heads/dev/v4/v4.0",
    timeoutMs: 600000,
    runGit: (args, options) => {
      calls.push({ args, options });
      return "";
    },
    containsCommit: () => true,
  });

  const fetch = calls.find(({ args }) => args[0] === "fetch");
  assert.ok(fetch);
  assert.equal(fetch.options.stdio, undefined);
  assert.equal(fetch.options.env.GIT_CONFIG_GLOBAL, ISOLATED_GIT_GLOBAL_CONFIG);
  assert.equal(fetch.options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(fetch.options.env.GIT_CONFIG_COUNT, "1");
  assert.equal(fetch.options.env.GIT_CONFIG_KEY_0, "safe.directory");
  assert.equal(
    fetch.options.env.GIT_CONFIG_VALUE_0,
    path.resolve("/tmp/buildchain-source-fetch-diagnostics-fixture"),
  );
});

test("source fetch ignores runner-global single-SHA URL rewrites", () => {
  const calls = [];
  fetchSourceCommit({
    targetPath: "/tmp/buildchain-source-fetch-isolation-fixture",
    remoteName: "origin",
    remoteUrl: "https://github.com/kungfu-systems/example.git",
    sha: "a".repeat(40),
    fetchRef: "refs/heads/dev/v4/v4.0",
    timeoutMs: 600000,
    env: {
      GIT_CONFIG_GLOBAL: "/tmp/stale-single-sha-bundle.gitconfig",
    },
    runGit: (args, options) => {
      calls.push({ args, options });
      return "";
    },
    containsCommit: () => true,
  });

  const fetch = calls.find(({ args }) => args[0] === "fetch");
  assert.ok(fetch);
  assert.equal(fetch.options.env.GIT_CONFIG_GLOBAL, ISOLATED_GIT_GLOBAL_CONFIG);
  assert.equal(fetch.options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(fetch.options.env.GIT_CONFIG_COUNT, "1");
  assert.equal(fetch.options.env.GIT_CONFIG_KEY_0, "safe.directory");
});

test("source fetch preserves command-scoped auth while isolating global config", () => {
  const calls = [];
  fetchSourceCommit({
    targetPath: "/tmp/buildchain-source-fetch-auth-fixture",
    remoteName: "origin",
    remoteUrl: "https://github.com/kungfu-systems/example.git",
    sha: "a".repeat(40),
    fetchRef: "refs/heads/dev/v4/v4.0",
    timeoutMs: 600000,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic redacted",
    },
    runGit: (args, options) => {
      calls.push({ args, options });
      return "";
    },
    containsCommit: () => true,
  });

  const fetch = calls.find(({ args }) => args[0] === "fetch");
  assert.ok(fetch);
  assert.equal(fetch.options.env.GIT_CONFIG_COUNT, "2");
  assert.equal(fetch.options.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(fetch.options.env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic redacted");
  assert.equal(fetch.options.env.GIT_CONFIG_KEY_1, "safe.directory");
  assert.equal(fetch.options.env.GIT_CONFIG_GLOBAL, ISOLATED_GIT_GLOBAL_CONFIG);
});

test("locked checkout accepts a regenerated pull merge commit with the exact locked tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-pull-merge-origin-"));
  git(["init"], root);
  git(["config", "user.name", "Buildchain Test"], root);
  git(["config", "user.email", "buildchain@example.test"], root);
  fs.writeFileSync(path.join(root, "README.md"), "same tree\n");
  git(["add", "README.md"], root);
  git(["commit", "-m", "original merge"], root);
  const originalSha = git(["rev-parse", "HEAD"], root);
  const tree = git(["rev-parse", "HEAD^{tree}"], root);
  git(["commit", "--amend", "-m", "regenerated merge"], root);
  const regeneratedSha = git(["rev-parse", "HEAD"], root);
  assert.notEqual(regeneratedSha, originalSha);
  assert.equal(git(["rev-parse", "HEAD^{tree}"], root), tree);

  const bare = `${root}.git`;
  git(["clone", "--bare", root, bare], path.dirname(root));
  git(["update-ref", "refs/pull/629/merge", regeneratedSha], bare);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-pull-merge-work-"));
  const evidence = lockedSourceCheckout({
    workspace,
    repository: "kungfu-systems/example",
    sourceSha: originalSha,
    sourceTreeSha: tree,
    fetchRef: "refs/pull/629/merge",
    mode: "off",
    githubRemote: `file://${bare}`,
    diagnosticsPath: ".buildchain/diagnostics/source-checkout.json",
  });

  assert.equal(evidence.verification.head, regeneratedSha);
  assert.equal(evidence.verification.expectedHead, originalSha);
  assert.equal(evidence.verification.headOk, false);
  assert.equal(evidence.verification.treeOk, true);
  assert.equal(evidence.verification.identityOk, true);
  assert.equal(evidence.verification.identityMode, "tree-equivalent-pull-merge");
});

test("source fetch does not spend a second raw-SHA timeout after a ref timeout", () => {
  const fetches = [];
  assert.throws(
    () => fetchSourceCommit({
      targetPath: "/tmp/buildchain-source-fetch-timeout-fixture",
      remoteName: "origin",
      remoteUrl: "https://github.com/kungfu-systems/example.git",
      sha: "b".repeat(40),
      fetchRef: "refs/heads/dev/v4/v4.0",
      timeoutMs: 600000,
      runGit: (args) => {
        if (args[0] === "fetch") {
          fetches.push(args);
          const error = new Error("spawnSync git ETIMEDOUT");
          error.code = "ETIMEDOUT";
          throw error;
        }
      },
      containsCommit: () => false,
    }),
    /ETIMEDOUT/,
  );
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].at(-1), "+refs/heads/dev/v4/v4.0:refs/buildchain/source-ref");
});

test("locked source checkout retries GitHub fallback fetch with a bounded attempt count", () => {
  let calls = 0;
  const failures = [];
  const result = runBoundedFetch({
    attempts: 3,
    fetch: () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error(`transient fetch failure ${calls}`);
        error.code = "ETIMEDOUT";
        throw error;
      }
      return "fetched";
    },
    onRetry: ({ attempt, error }) => failures.push({ attempt, code: error.code }),
  });
  assert.equal(result.value, "fetched");
  assert.equal(result.attempts, 3);
  assert.deepEqual(failures, [{ attempt: 1, code: "ETIMEDOUT" }, { attempt: 2, code: "ETIMEDOUT" }]);
});

test("locked source checkout stops after the configured fallback fetch attempts", () => {
  let calls = 0;
  assert.throws(() => runBoundedFetch({ attempts: 2, fetch: () => { calls += 1; throw new Error("upstream unavailable"); } }), /upstream unavailable/);
  assert.equal(calls, 2);
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
