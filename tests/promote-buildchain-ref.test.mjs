import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  assertAllowedLocalChanges,
  assertChannelPromotionPr,
  assertPromotableRepository,
  assertPromotableTargetRef,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  latestAlphaForPatch,
  parseReleaseLineRef,
  parseTags,
  persistDurableReleaseTransaction,
  promoteBuildchainRefs,
  restoreDurableReleaseTransaction,
  resolveTagsForTarget,
  runVersionVerification,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
  validatePromotionReleaseCandidate,
} = await import("../actions/promote-buildchain-ref/lib.js");
const {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} = await import("../packages/core/release-line-dry-run.js");
const {
  transitionReleaseTransaction,
} = await import("../packages/core/publish-transaction.js");
const {
  validateRequiredPublishSourceLock,
  collectGitHubReleaseEvidenceAssets,
  publishGitHubReleaseEvidence,
} = await import("../actions/promote-buildchain-ref/index.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function productionImpactJson({ tag = "v1.0.0", line = "v1.0", rationale = "Production promotion preserves existing registered surfaces." } = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { tag, line },
    versionImpact: {
      final: "patch",
      source: "surface-register",
      rationale,
    },
    surfaceImpacts: [
      {
        id: "release-governance",
        impact: "patch",
        class: "compatible",
        rationale: "Promotion finalizes release evidence without changing a registered public surface.",
      },
    ],
  });
}

function notFound() {
  return Object.assign(new Error("Reference does not exist"), {
    status: 422,
    response: { data: { message: "Reference does not exist" } },
  });
}

function alreadyExists() {
  return Object.assign(new Error("Reference already exists"), {
    status: 422,
    response: { data: { message: "Reference already exists" } },
  });
}

function versionStateBranchName(branch, sha) {
  return `buildchain/version-state/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
}

function transientGitHubError(message = "other side closed") {
  return Object.assign(new Error(message), {
    status: 500,
    response: { status: 500, data: { message } },
  });
}

function createGitMock({ refs = new Map(), orderFile = "" } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const commitLog = [];
  let blobCount = 0;
  let treeCount = 0;
  let commitCount = 0;
  const appendOrder = (entry) => {
    if (orderFile) {
      fs.appendFileSync(orderFile, `${entry}\n`);
    }
  };
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => {
          const commit = commits.get(commit_sha);
          if (commit) {
            return { data: commit };
          }
          return { data: { tree: { sha: `tree-${commit_sha}` }, parents: [] } };
        },
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
        }),
        getBlob: async ({ file_sha }) => {
          const blob = blobs.get(file_sha);
          if (!blob) {
            throw notFound();
          }
          return { data: blob };
        },
        createBlob: async ({ content, encoding }) => {
          const sha = `blob-${++blobCount}`;
          const normalized =
            encoding === "base64"
              ? content
              : Buffer.from(content).toString("base64");
          blobs.set(sha, { content: normalized, encoding: "base64" });
          return { data: { sha } };
        },
        createTree: async ({ tree, base_tree: baseTree }) => {
          const sha = `tree-created-${++treeCount}`;
          const entries = baseTree && trees.has(baseTree) ? [...trees.get(baseTree)] : [];
          for (const entry of tree) {
            const nextEntry = { ...entry };
            const index = entries.findIndex((existing) => existing.path === nextEntry.path);
            if (index >= 0) {
              entries[index] = nextEntry;
            } else {
              entries.push(nextEntry);
            }
          }
          trees.set(sha, entries);
          return { data: { sha } };
        },
        createCommit: async ({ message, tree, parents = [] }) => {
          const sha = `commit-${++commitCount}`.padEnd(40, "0");
          const commit = {
            sha,
            tree: { sha: tree },
            parents: parents.map((parentSha) => ({ sha: parentSha })),
          };
          commits.set(sha, commit);
          commitLog.push({ sha, message, parents, tree });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          appendOrder(`update:${ref}`);
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          appendOrder(`create:${ref}`);
          const refName = ref.replace(/^refs\//, "");
          if (refs.has(refName)) {
            throw alreadyExists();
          }
          refs.set(refName, sha);
          return {};
        },
      },
    },
  };
  return { octokit, refs, blobs, trees, commits, commitLog };
}

function makeTempWorkspace(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-promote-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
    );
  }
  return cwd;
}

function run(command, cwd) {
  execFileSync(command[0], command.slice(1), {
    cwd,
    stdio: "ignore",
  });
}

function protectedChannel(overrides = {}) {
  return {
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_status_checks: { strict: true, contexts: ["check"] },
    ...overrides,
  };
}

test("parseTags accepts only ABV-style buildchain tags", () => {
  assert.deepEqual(
    parseTags("v1, v1.0, v1.0-alpha, v1.0.0, v1.0.1-alpha.0, v1"),
    ["v1", "v1.0", "v1.0-alpha", "v1.0.0", "v1.0.1-alpha.0"],
  );
  assert.throws(
    () => parseTags("1.0.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("v1-alpha"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("v1.0.1.alpha.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("latest"),
    /Unsupported buildchain promotion tag/,
  );
});

test("promotion is limited to buildchain alpha and release line refs", () => {
  assertPromotableRepository("kungfu-systems", "buildchain");
  assertPromotableTargetRef("alpha/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.1");
  assertPromotableTargetRef("publish-gate/major");
  assertPromotableTargetRef("major-gate");
  assert.throws(
    () => assertPromotableRepository("kungfu-systems", "other"),
    /limited to kungfu-systems\/buildchain/,
  );
  assert.throws(
    () => assertPromotableTargetRef("dev/v1/v1.0"),
    /alpha\/vN\/vN\.M, release\/vN\/vN\.M, publish-gate\/major, or major-gate/,
  );
  assert.throws(
    () => assertPromotableTargetRef("release/v1/v2.0"),
    /major mismatch/,
  );
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1.0-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.1"), ["v1", "v1.1"]);
  assert.deepEqual(resolveTagsForTarget("publish-gate/major"), []);
  assert.deepEqual(resolveTagsForTarget("major-gate"), []);
  assert.throws(
    () => resolveTagsForTarget("alpha/v1/v1.0", ["v1"]),
    /not allowed for alpha promotion/,
  );
  assert.throws(
    () => resolveTagsForTarget("release/v1/v1.0", ["v1.1.0"]),
    /not allowed for release promotion/,
  );
});

test("channel promotion PR lineage retries transient GitHub API failures", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  let calls = 0;
  const octokit = {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          calls += 1;
          assert.equal(commit_sha, SHA);
          if (calls === 1) {
            throw transientGitHubError("other side closed");
          }
          return {
            data: [
              {
                merged_at: "2026-07-04T00:00:00Z",
                base: { ref: "alpha/v1/v1.0" },
                head: {
                  ref: "dev/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  try {
    await assertChannelPromotionPr({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
    });
    assert.equal(calls, 2);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("release transaction complete transition clears stale failure", () => {
  const record = {
    schema: 1,
    id: "tx-stale-failure",
    repository: "kungfu-systems/buildchain",
    target_ref: "alpha/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0-alpha.0",
    exact_tag: "v1.0.0-alpha.0",
    channel: "alpha",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0-alpha-0",
    state_path: "",
    evidence_path: "",
    state: "finalizing",
    previous_state: "published",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "GitHub API 500: other side closed",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };

  const complete = transitionReleaseTransaction(record, "complete", {
    actor: "codex",
    runId: "2",
  });
  assert.equal(complete.state, "complete");
  assert.equal(complete.failure, "");

  const cleanedRerun = transitionReleaseTransaction({
    ...complete,
    failure: "GitHub API 500: other side closed",
  }, "complete", {
    actor: "codex",
    runId: "3",
  });
  assert.equal(cleanedRerun.state, "complete");
  assert.equal(cleanedRerun.failure, "");
});

test("promote action validates generic publish source locks before promotion", () => {
  const report = validateRequiredPublishSourceLock({
    sha: SHA,
    publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
    publishSourceSha: SHA,
    publishSourceLocked: "true",
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.publishSource.channel, "release");

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "release/v22/v22.22",
      publishSourceSha: SHA,
      publishSourceLocked: "true",
    }),
    /publish source-lock validation failed: .*publish\.source_ref/,
  );

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      publishSourceSha: SHA,
      publishSourceLocked: "false",
    }),
    /publish source-lock validation failed: .*publish\.source_locked/,
  );

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      publishSourceSha: OTHER_SHA,
      publishSourceLocked: "true",
    }),
    /does not match promotion sha/,
  );
});

test("promote action collects GitHub Release evidence assets fail-closed", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": { release: { tag: "v1.0.0" } },
    ".buildchain/release-passport/evidence.json": { passport: true },
  });

  assert.deepEqual(
    collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    }).map((entry) => path.relative(cwd, entry).split(path.sep).join("/")),
    [
      ".buildchain/release-evidence/v1.0.0/evidence.json",
      ".buildchain/release-passport/buildchain.release.json",
      ".buildchain/release-passport/evidence.json",
    ],
  );

  assert.throws(
    () => collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/missing.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    }),
    /requires a publish evidence file/,
  );
});

test("promote action publishes semver GitHub Release evidence assets", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": { release: { tag: "v1.0.1-alpha.0" } },
    ".buildchain/release-passport/kfd-2.json": { ok: true },
  });
  const uploaded = [];
  const deleted = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/releases/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (String(url).endsWith("/git/ref/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 });
    }
    if (String(url).endsWith("/releases") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.prerelease, true);
      assert.equal(body.make_latest, "false");
      assert.equal(body.target_commitish, SHA);
      return new Response(JSON.stringify({ id: 123, html_url: "https://github.test/release" }), { status: 201 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({
          data: [{ id: 7, name: "evidence.json" }],
        }),
        deleteReleaseAsset: async ({ asset_id }) => {
          deleted.push(asset_id);
          return {};
        },
        uploadReleaseAsset: async ({ name, data }) => {
          uploaded.push({ name, size: data.length });
          return {};
        },
      },
    },
  };

  const result = await publishGitHubReleaseEvidence({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    token: "token",
    apiUrl: "https://api.github.test",
    tag: "v1.0.1-alpha.0",
    target: SHA,
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json"),
    releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
  });

  assert.equal(result.action, "created");
  assert.equal(result.assetCount, 3);
  assert.deepEqual(deleted, [7]);
  assert.deepEqual(uploaded.map((asset) => asset.name), [
    "evidence.json",
    "buildchain.release.json",
    "kfd-2.json",
  ]);
});

test("governance maps channel targets to the only legal PR source", () => {
  assert.equal(expectedHeadRefForTarget("alpha/v1/v1.0"), "dev/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("release/v1/v1.0"), "alpha/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("publish-gate/major"), "release/vN/vN.M");
  assert.equal(expectedHeadRefForTarget("major-gate"), "release/vN/vN.M");
  assert.deepEqual(parseReleaseLineRef("release/v1/v1.0"), {
    ref: "release/v1/v1.0",
    major: 1,
    minor: 0,
  });
  assert.deepEqual(
    latestAlphaForPatch(
      [
        { ref: "refs/tags/v1.0.2-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.2-alpha.1", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.3-alpha.0", object: { sha: "c".repeat(40) } },
      ],
      "v1.0",
      2,
    ),
    { tag: "v1.0.2-alpha.1", patch: 2, prerelease: 1, sha: OTHER_SHA },
  );
});

test("release line dry-run explains alpha promotion semantics", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "fixture",
      version: "2.0.0-alpha.0",
    },
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "alpha/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "alpha");
  assert.equal(plan.source.expectedHeadRef, "dev/v2/v2.0");
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "alpha/v2/v2.0",
    "dev/v2/v2.0",
  ]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0-alpha"]);
  assert.match(formatReleaseLineDryRun(plan), /No refs, tags, packages, or files were modified/);
});

test("release line dry-run explains production and next-alpha semantics", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `schema = 1

[version]
required = true

[[version.files]]
path = "VERSION"
type = "regex"
pattern = "VERSION=(?<version>[^\\n]+)"
replacement = "VERSION={{version}}"
`,
    VERSION: "VERSION=2.0.1-alpha.0\n",
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "release/v2/v2.0",
    sha: SHA,
    tags: ["v2.0.1", "v2.0.2-alpha.0"],
    publishTransaction: true,
  });

  assert.equal(plan.channel, "release");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v2.0.1", "v2.0.2-alpha.0"]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0", "v2", "v2.0-alpha"]);
  assert.equal(plan.publishTransaction.enabled, true);
  assert.equal(plan.versionState.manager, "buildchain.toml");
  assert.deepEqual(plan.versionState.files, ["VERSION"]);
  assert.match(plan.governanceChecks.join("\n"), /same-patch exact alpha tag tree/);
});

test("release line dry-run resolves major gate from explicit source ref", () => {
  const plan = explainReleaseLineDryRun({
    cwd: makeTempWorkspace({}),
    targetRef: "publish-gate/major",
    sourceRef: "release/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "major");
  assert.equal(plan.line, "v3.0");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v3.0.0", "v3.0.1-alpha.0"]);
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "publish-gate/major",
    "release/v3/v3.0",
    "alpha/v3/v3.0",
    "dev/v3/v3.0",
  ]);
});

test("selectReleaseTag creates, increments, and reuses canonical v-prefixed release tags", () => {
  assert.deepEqual(
    selectReleaseTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0",
      patch: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1", object: { sha: SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1", patch: 1, exists: true },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/1.0.99", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/heads/buildchain/release-state/1-0-1", object: { sha: OTHER_SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2", patch: 2, exists: false },
  );
});

test("selectAlphaTag creates ABV-style prerelease tags for the minor line", () => {
  assert.deepEqual(
    selectAlphaTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0-alpha.0",
      patch: 0,
      prerelease: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.0", patch: 1, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        { ref: "refs/heads/buildchain/release-state/1-0-1", object: { sha: OTHER_SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2-alpha.0", patch: 2, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    {
      tag: "v1.0.1-alpha.0",
      patch: 1,
      prerelease: 0,
      sha: SHA,
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.1", object: { sha: "b".repeat(40) } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    {
      tag: "v1.0.1-alpha.1",
      patch: 1,
      prerelease: 1,
      sha: "b".repeat(40),
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
});

test("discoverVersionStateFiles follows package-manager workspace metadata", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "actions/no-version/package.json": {
      name: "@kungfu-systems/no-version",
      private: true,
    },
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "pnpm");
  assert.deepEqual(
    discovered.files.map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
  assert.deepEqual(
    updateVersionStateContents(discovered.files, "1.0.1").map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
});

test("discoverVersionStateFiles prefers buildchain.toml version state", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pyproject.toml": '[project]\nname = "example"\nversion = "1.0.0-alpha.0"\n',
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "buildchain.toml");
  assert.deepEqual(discovered.files.map((file) => file.path), ["pyproject.toml"]);
  const changed = updateVersionStateContents(discovered.files, "1.0.1");
  assert.equal(changed.length, 1);
  assert.match(changed[0].content, /version = "1.0.1"/);
});

test("version verification allows only discovered version-state file changes", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "actions/one/package.json"),
    JSON.stringify({ name: "@kungfu-systems/one", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "changed\n");

  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
    /README\.md/,
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  assert.doesNotThrow(() =>
    assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
  );
});

test("version-state lifecycle can materialize declared derived files before verification", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "dist/site/buildchain-contract.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/generate-site-contract.mjs"

[lifecycle.verify]
command = "node scripts/check-site-contract.mjs"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "dist/site/buildchain-contract.json": {
      product: { version: "1.0.0-alpha.0" },
      generated: false,
    },
    "scripts/generate-site-contract.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync("dist/site/buildchain-contract.json", JSON.stringify({
  product: { version: pkg.version },
  generated: true
}, null, 2) + "\\n");
`,
    "scripts/check-site-contract.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const contract = JSON.parse(fs.readFileSync("dist/site/buildchain-contract.json", "utf8"));
assert.equal(contract.product.version, pkg.version);
assert.equal(contract.generated, true);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const discovered = discoverVersionStateFiles(cwd);
  const changedFiles = updateVersionStateContents(discovered.files, "1.0.1-alpha.0");
  const verifiedChangedFiles = runVersionVerification({
    cwd,
    loadedConfig: discovered.config,
    version: "1.0.1-alpha.0",
    changedFiles,
    allowedPaths: discovered.files.map((file) => file.path),
  });

  assert.deepEqual(
    verifiedChangedFiles.map((file) => file.path),
    ["dist/site/buildchain-contract.json", "package.json"],
  );
  const contract = JSON.parse(
    verifiedChangedFiles.find((file) => file.path === "dist/site/buildchain-contract.json").content,
  );
  assert.deepEqual(contract, {
    product: { version: "1.0.1-alpha.0" },
    generated: true,
  });
});

test("release promotion creates v-prefixed release tag and prepares next alpha tag", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/release/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return { data: [] };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["getRef", "tags/v1.0.0"],
    ["createRef", "refs/tags/v1.0.0", SHA],
    ["updateRef", "tags/v1.0", SHA, true],
    ["getRef", "tags/v1.1"],
    ["updateRef", "tags/v1", SHA, true],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
  ]);
});

test("release promotion does not move v1 when the next minor line exists", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/release/v1/v1.0" || ref === "tags/v1.1") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        updateRef: async () => ({}),
        createRef: async () => ({}),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "skipped-next-minor-exists", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
});

test("alpha promotion creates exact prerelease tag and moves only the minor alpha tag", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return {
            data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
          };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
  ]);
});

test("rerunning the same release SHA reuses exact tags", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (
            ref === "heads/release/v1/v1.0" ||
            ref === "tags/v1.0.0" ||
            ref === "tags/v1.0.1-alpha.0"
          ) {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({
          data: [
            { ref: "refs/tags/v1.0.0", object: { sha: SHA } },
            { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } },
          ],
        }),
        updateRef: async () => ({}),
        createRef: async () => {
          throw new Error("createRef should not be called for exact tags");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "existing", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
});

test("release promotion creates source version commits and points refs at them", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.0-alpha.0",
      private: true,
    },
  });
  const refs = new Map([["heads/release/v1/v1.0", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
  let getCommitCalls = 0;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => {
          getCommitCalls += 1;
          if (getCommitCalls === 1) {
            throw Object.assign(new Error("other side closed"), { status: 500 });
          }
          return { data: { tree: { sha: `tree-${commit_sha}` } } };
        },
        createBlob: async ({ content }) => {
          const sha = `blob-${blobs.length + 1}`;
          blobs.push({ sha, content });
          return { data: { sha } };
        },
        createTree: async ({ tree }) => ({
          data: { sha: `tree-created-${tree.map((item) => item.sha).join("-")}` },
        }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        update: async (input) => {
          repoUpdates.push(input);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(getCommitCalls, 3);
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      ["chore(release): release v1.0.0", [SHA]],
      ["chore(release): prepare v1.0.1-alpha.0", [releaseSha]],
    ],
  );
  assert.equal(blobs.length, 4);
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "1.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "1.0.1-alpha.0"')),
  );
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "created-version-state")
      .map((update) => [update.version, update.packageManager]),
    [
      ["1.0.0", "pnpm"],
      ["1.0.1-alpha.0", "pnpm"],
    ],
  );
});

test("release promotion updates default branch before direct next-alpha sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", SHA],
  ]);
  const commits = [];
  const repoUpdates = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        update: async (input) => {
          repoUpdates.push(input);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, undefined);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "updated-default-branch" || update.ref === "alpha/v1/v1.0")
      .map((update) => [update.ref, update.action]),
    [
      ["dev/v1/v1.0", "updated-default-branch"],
      ["alpha/v1/v1.0", "updated"],
    ],
  );
});

test("release finalization merges protected alpha next-alpha ancestry", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", OTHER_SHA],
  ]);
  const commits = [];
  let createdPullRequest;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        getTree: async () => ({
          data: { tree: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0" && sha.startsWith("commit-2")) {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            error.response = { data: { message: "Update is not a fast forward" } };
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: `https://github.com/kungfu-systems/buildchain/pull/test`,
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        update: async () => ({}),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  const nextAlphaMergeSha = commits[2].sha;
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaMergeSha);
  assert.deepEqual(commits[1].parents, [releaseSha]);
  assert.deepEqual(commits[2].parents, [OTHER_SHA, nextAlphaSha]);
  assert.equal(createdPullRequest, undefined);
  assert.equal(result.nextAlphaSha, nextAlphaMergeSha);
  assert.equal(
    result.updates.some(
      (update) =>
        update.ref === "alpha/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === nextAlphaMergeSha,
    ),
    true,
  );
});

test("publish transaction gates alpha final refs on lifecycle.publish evidence", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.appendFileSync("order.log", "publish\\n");
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commitLog } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha",
      },
    ]),
  });

  const alphaSha = commitLog[0].sha;
  assert.equal(result.sha, alphaSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.failure, "");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), alphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaSha);
  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8").trim().split("\n");
  assert.equal(order[0], "create:refs/heads/buildchain/release-state/1-0-0-alpha-0");
  assert.equal(order.filter((entry) => entry.includes("buildchain/release-state")).length >= 4, true);
  assert.deepEqual(order.filter((entry) => !entry.includes("buildchain/release-state")), [
    "publish",
    "update:heads/alpha/v1/v1.0",
    "create:refs/heads/dev/v1/v1.0",
    "create:refs/tags/v1.0.0-alpha.0",
    "update:tags/v1.0-alpha",
  ]);
});

test("release final-version trusted publishing runs without npm token auth", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync("publish-env.json", JSON.stringify({
  mode: process.env.BUILDCHAIN_PUBLISH_MODE,
  auth: process.env.BUILDCHAIN_PUBLISH_AUTH,
  distTag: process.env.BUILDCHAIN_NPM_DIST_TAG,
  tokenConfigured: Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken)
}, null, 2) + "\\n");
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:release"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha256:release",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, "publish-env.json"), "utf8")),
      {
        mode: "publish-final-version",
        auth: "trusted-publishing",
        distTag: "latest",
        tokenConfigured: false,
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("publish transaction skips alpha versions occupied by durable state refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha1",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), true);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-1"), true);
});

test("release publish transaction can promote existing npm artifacts by dist tag", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
package_set_order = "platforms-first-main-last"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );
  fs.chmodSync(path.join(binDir, "npm"), 0o755);

  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportProductName: "Libnode",
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-linux-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "linux-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-darwin-arm64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "darwin-arm64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-win32-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "win32-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "main",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(cwd, result.publishTransaction.evidencePath), "utf8"),
    );
    assert.deepEqual(evidence.artifacts, [
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-linux-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-darwin-arm64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-win32-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "main",
        required: true,
      },
    ]);
    assert.deepEqual(
      fs.readFileSync(process.env.NPM_LOG, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("dist-tag add")),
      [
        "dist-tag add @kungfu-tech/buildchain-linux-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-darwin-arm64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-win32-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain@1.0.0 latest",
      ],
    );
    assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
    assert.equal(result.publishTransaction.releasePassportOutputDir, ".buildchain/release-passport");
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.publishTransaction.releasePassportStateSha);
    const stateCommit = commits.get(result.publishTransaction.releasePassportStateSha);
    const passportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
      entry.path === "release-passport/buildchain.release.json"
    );
    assert.ok(passportEntry);
    const passport = JSON.parse(
      Buffer.from(blobs.get(passportEntry.sha).content, "base64").toString("utf8"),
    );
    assert.equal(passport.packageSet.platforms.length, 3);
    assert.equal(passport.product.name, "Libnode");
    assert.equal(passport.distTagPromotion.fields.distTag, "latest");
    assert.equal(passport.release.releaseStateRef, "refs/heads/buildchain/release-state/1-0-0");
    assert.match(passport.release.releaseStateSha, /^commit-\d+0+$/);
    assert.ok(commits.has(passport.release.releaseStateSha));
    assert.equal(stateCommit.parents[0].sha, passport.release.releaseStateSha);
    assert.equal(passport.buildSummary, undefined);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release passport verification failure blocks durable passport persistence", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );
  fs.chmodSync(path.join(binDir, "npm"), 0o755);

  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    await assert.rejects(
      () => promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        releasePassportProductName: "Libnode",
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0",
            digest: "sha512-rebuilt",
            role: "main",
          },
        ]),
      }),
      /Release passport generated check failed.*impact\.surfaceImpacts\.required/,
    );

    const stateSha = refs.get("heads/buildchain/release-state/1-0-0");
    assert.ok(stateSha);
    const stateCommit = commits.get(stateSha);
    assert.ok(stateCommit);
    assert.equal(
      (trees.get(stateCommit.tree.sha) || []).some((entry) =>
        entry.path === "release-passport/buildchain.release.json"
      ),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release existing-version promotion fails before transaction side effects without npm token", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    await assert.rejects(
      () =>
        promoteBuildchainRefs({
          octokit,
          owner: "kungfu-systems",
          repo: "buildchain",
          sha: SHA,
          targetRef: "release/v1/v1.0",
          cwd,
          publishTransaction: true,
          publishRequiredArtifactsJson: JSON.stringify([
            {
              kind: "npm",
              name: "@kungfu-tech/buildchain",
              ref: "1.0.0",
              digest: "sha512-existing",
            },
          ]),
        }),
      /requires npm token auth before dist-tag promotion/,
    );
    assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
    assert.equal(refs.has("tags/v1.0.0"), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release final-version trusted publishing rejects alpha package refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha512-alpha",
          },
        ]),
      }),
    /must publish final package refs, not alpha refs/,
  );
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
  assert.equal(refs.has("tags/v1.0.0"), false);
});

test("publish transaction replaces stale current alpha transaction identity", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha1",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0-alpha-0") !== OTHER_SHA, true);
  const recovered = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0-alpha-0",
    statePath: path.join(cwd, ".buildchain", "release-state.json"),
    evidencePath: path.join(cwd, ".buildchain", "publish-evidence.json"),
  });
  assert.equal(recovered.source_sha, SHA);
  assert.equal(recovered.release_sha, SHA);
  assert.equal(recovered.state, "complete");
});

test("publish transaction ignores local-only stale alpha residue", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha0"
  }]
}, null, 2) + "\\n");
`,
  });
  const localStatePath = path.join(cwd, ".buildchain", "release-state", "v1.0.0-alpha.0.json");
  fs.mkdirSync(path.dirname(localStatePath), { recursive: true });
  fs.writeFileSync(
    localStatePath,
    JSON.stringify(
      {
        schema: 1,
        id: "local-residue",
        repository: "kungfu-systems/buildchain",
        target_ref: "alpha/v1/v1.0",
        source_sha: OTHER_SHA,
        release_sha: OTHER_SHA,
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        version: "1.0.0-alpha.99",
        exact_tag: "v1.0.0-alpha.99",
        channel: "alpha",
        line: "v1.0",
        version_strategy: "",
        lifecycle_identity: "lifecycle.publish",
        state_ref: "buildchain/release-state/1-0-0-alpha-99",
        state_path: localStatePath,
        evidence_path: "",
        state: "complete",
        previous_state: "finalizing",
        actor: "",
        run_id: "",
        superseded_by: "",
        failure: "",
        artifacts: [],
        evidence: [],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-99"), false);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
});

test("declared alpha version outranks older resumable durable state", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha-current"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "old-open-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: SHA,
      release_material_sha: SHA,
      publish_tooling_sha: SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "publishing",
      previous_state: "prepared",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.1-alpha.1",
          digest: "sha256:stale-alpha",
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.1-alpha.1/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.1-alpha.0",
        digest: "sha256:alpha-current",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.1-alpha.0");
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-1-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), undefined);
});

test("alpha promotion skips published durable state reached only through channel history", async () => {
  const staleSourceSha = "7".repeat(40);
  const staleReleaseSha = "8".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha-current"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  commits.set(SHA, {
    sha: SHA,
    tree: { sha: `tree-${SHA}` },
    parents: [{ sha: staleReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: staleSourceSha,
      release_sha: staleReleaseSha,
      release_material_sha: staleReleaseSha,
      publish_tooling_sha: staleReleaseSha,
      version: "1.0.1-alpha.1",
      exact_tag: "v1.0.1-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-1-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.1-alpha.1",
          digest: "sha256:stale-alpha",
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.1-alpha.1/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.1-alpha.2");
  assert.equal(refs.get("heads/alpha/v1/v1.0"), result.sha);
  assert.equal(refs.get("tags/v1.0.1-alpha.2"), result.sha);
  assert.equal(refs.get("tags/v1.0-alpha"), result.sha);
  assert.equal(refs.has("tags/v1.0.1-alpha.1"), false);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-1-alpha-2"), true);
});

test("publish transaction resumes matching alpha durable state refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha0"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "non-matching-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.1",
      exact_tag: "v1.0.0-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "publishing",
      previous_state: "prepared",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });
  const matchingEvidencePath = path.join(cwd, "durable-alpha-0-evidence.json");
  fs.writeFileSync(
    matchingEvidencePath,
    JSON.stringify(
      {
        schema: 1,
        version: "1.0.0-alpha.0",
        channel: "alpha",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        target_ref: "alpha/v1/v1.0",
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        artifacts: [
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha256:alpha0",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "matching-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: matchingEvidencePath,
  });
  fs.unlinkSync(matchingEvidencePath);

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.publishTransaction.releaseSha, OTHER_SHA);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), OTHER_SHA);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), OTHER_SHA);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.1.json")),
    false,
  );
});

test("publish transaction finalizes current alpha version-state merge commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", mergeSha]]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-merge-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    result.updates.some((update) => update.action === "stale-publish-transaction"),
    false,
  );
});

test("publish transaction resumes partial alpha finalization with exact tag on release material", async () => {
  const oldAlphaSha = "3".repeat(40);
  const versionHeadSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const previousFinalizedSha = "6".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", mergeSha],
      ["heads/dev/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "7".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-partial-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("heads/alpha/v1/v1.0"), mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
});

test("completed alpha transaction does not reuse exact tag for new alpha material", async () => {
  const oldAlphaSha = "3".repeat(40);
  const versionHeadSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const previousFinalizedSha = "6".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha-next"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", mergeSha],
      ["heads/dev/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", previousFinalizedSha],
      ["tags/v1.0-alpha", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "7".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-complete",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: previousFinalizedSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "complete",
      previous_state: "finalizing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    requireVersionState: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha-next",
      },
    ]),
  });

  assert.notEqual(result.sha, mergeSha);
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.1"), result.sha);
  assert.equal(refs.get("tags/v1.0-alpha"), result.sha);
});

test("publish transaction finalizes current release version-state merge commits", async () => {
  const oldReleaseSha = "d".repeat(40);
  const alphaSha = "e".repeat(40);
  const versionHeadSha = "f".repeat(40);
  const mergeSha = "1".repeat(40);
  const toolingMergeSha = "2".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", toolingMergeSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
    ]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: oldReleaseSha }, { sha: versionHeadSha }],
  });
  commits.set(toolingMergeSha, {
    sha: toolingMergeSha,
    tree: { sha: `tree-${toolingMergeSha}` },
    parents: [{ sha: mergeSha }, { sha: "3".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  const distTagEvidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/dist-tag-evidence.json");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify({
      schema: 1,
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      channel: "release",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      target_ref: "release/v1/v1.0",
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
        },
      ],
    }, null, 2)}\n`,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-merge-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: evidencePath,
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
          role: "main",
          required: true,
        },
      ],
      evidence: [
        ".buildchain/release-evidence/v1.0.0/evidence.json",
        ".buildchain/release-evidence/v1.0.0/dist-tag-evidence.json",
      ],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: toolingMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireVersionState: true,
  });

  assert.equal(result.sha, toolingMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0");
  assert.equal(refs.get("tags/v1.0.0"), toolingMergeSha);
  assert.equal(refs.get("tags/v1.0"), toolingMergeSha);
  assert.equal(refs.get("tags/v1"), toolingMergeSha);
  assert.equal(refs.has("tags/v1.0.1"), false);
  assert.equal(
    result.updates.some((update) => update.action === "stale-publish-transaction"),
    false,
  );
  assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
  const stateCommit = commits.get(result.publishTransaction.releasePassportStateSha);
  const passportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
    entry.path === "release-passport/buildchain.release.json"
  );
  const checkReportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
    entry.path === "release-passport/check-report.json"
  );
  assert.ok(passportEntry);
  assert.ok(checkReportEntry);
  const passport = JSON.parse(Buffer.from(blobs.get(passportEntry.sha).content, "base64").toString("utf8"));
  const checkReport = JSON.parse(Buffer.from(blobs.get(checkReportEntry.sha).content, "base64").toString("utf8"));
  assert.equal(passport.release.sourceSha, oldReleaseSha);
  assert.equal(passport.trustedPublishing.enabled, true);
  assert.equal(passport.trustedPublishing.auth, "trusted-publishing");
  assert.equal(passport.distTagPromotion, undefined);
  assert.equal(checkReport.ok, true);
});

test("release finalization uses the transaction alpha source after next-alpha advances", async () => {
  const oldReleaseSha = "4".repeat(40);
  const alphaZeroSha = "5".repeat(40);
  const alphaOneSha = "6".repeat(40);
  const releaseSourceSha = "7".repeat(40);
  const versionHeadSha = "8".repeat(40);
  const finalMergeSha = "9".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", finalMergeSha],
      ["tags/v1.0.0-alpha.0", alphaZeroSha],
      ["tags/v1.0.0-alpha.1", alphaOneSha],
      ["tags/v1.0-alpha", alphaOneSha],
    ]),
  });
  commits.set(alphaZeroSha, {
    sha: alphaZeroSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  commits.set(alphaOneSha, {
    sha: alphaOneSha,
    tree: { sha: "alpha-one-tree" },
    parents: [],
  });
  commits.set(releaseSourceSha, {
    sha: releaseSourceSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [{ sha: oldReleaseSha }, { sha: alphaZeroSha }],
  });
  commits.set(versionHeadSha, {
    sha: versionHeadSha,
    tree: { sha: "release-version-tree" },
    parents: [{ sha: releaseSourceSha }],
  });
  commits.set(finalMergeSha, {
    sha: finalMergeSha,
    tree: { sha: "final-release-tree" },
    parents: [{ sha: releaseSourceSha }, { sha: versionHeadSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      assert.equal(basehead, `${releaseSourceSha}...${finalMergeSha}`);
      return { data: { files: [{ filename: "package.json" }] } };
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseSourceSha
          ? [
              {
                merged_at: "2026-07-05T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "alpha/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify({
      schema: 1,
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      channel: "release",
      source_sha: releaseSourceSha,
      release_sha: versionHeadSha,
      target_ref: "release/v1/v1.0",
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
        },
      ],
    }, null, 2)}\n`,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-finalization-alpha-source",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: releaseSourceSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: evidencePath,
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
          role: "main",
          required: true,
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.0/evidence.json"],
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
    },
    evidencePath,
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: finalMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, finalMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(refs.get("tags/v1.0.0"), finalMergeSha);
});

test("release finalization merges generated next-alpha state into diverged dev", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const devHeadSha = "b".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: originalPackageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: originalPackageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaHeadSha }],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const checkRuns = [];
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/dev/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async (request) => {
      checkRuns.push(request);
      return { data: { id: checkRuns.length } };
    },
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      assert.match(basehead, new RegExp(`^${devHeadSha}\\.\\.\\.commit-\\d+0+$`));
      return {
        data: {
          files: [
            { filename: "package.json" },
            { filename: "actions/promote-buildchain-ref/lib.js" },
          ],
        },
      };
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === "chore(release): release v1.0.0",
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === "chore(release): prepare v1.0.1-alpha.0",
  );
  const devMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === devHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(devMergeCommit);
  assert.equal(result.sha, releaseVersionCommit.sha);
  assert.equal(result.nextAlphaSha, nextAlphaCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), devMergeCommit.sha);
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === nextAlphaCommit.sha,
    ),
  );
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === devMergeCommit.sha,
    ),
  );
  assert.ok(
    result.updates.some(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === devMergeCommit.sha &&
        update.sourceSha === nextAlphaCommit.sha &&
        update.currentSha === devHeadSha,
    ),
  );
});

test("release finalization merges release ancestry into generated next-alpha", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const devHeadSha = "b".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: originalPackageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("release-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: originalPackageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: originalPackageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "release-tree" },
    parents: [],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/alpha/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async () => ({ data: { id: 1 } }),
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === "chore(release): release v1.0.0",
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === "chore(release): prepare v1.0.1-alpha.0",
  );
  const alphaMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === alphaHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(alphaMergeCommit);
  assert.equal(nextAlphaCommit.parents[0], releaseVersionCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaMergeCommit.sha);
  assert.equal(result.nextAlphaSha, alphaMergeCommit.sha);
});

test("release promotion uses frozen PR alpha evidence when a later same-patch alpha exists", async () => {
  const oldReleaseSha = "4".repeat(40);
  const alphaZeroSha = "5".repeat(40);
  const alphaOneSha = "6".repeat(40);
  const promotionHeadSha = "7".repeat(40);
  const releaseMergeSha = "8".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    group: "node",
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha512-release"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseMergeSha],
      ["tags/v1.0.0-alpha.0", alphaZeroSha],
      ["tags/v1.0.0-alpha.1", alphaOneSha],
      ["tags/v1.0-alpha", alphaOneSha],
    ]),
  });
  commits.set(alphaZeroSha, {
    sha: alphaZeroSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  commits.set(alphaOneSha, {
    sha: alphaOneSha,
    tree: { sha: "alpha-one-tree" },
    parents: [{ sha: alphaZeroSha }],
  });
  commits.set(promotionHeadSha, {
    sha: promotionHeadSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [{ sha: oldReleaseSha }, { sha: alphaZeroSha }],
  });
  commits.set(releaseMergeSha, {
    sha: releaseMergeSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async () => {
      return { data: { files: [{ filename: "package.json" }] } };
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseMergeSha
          ? [
              {
                merged_at: "2026-07-07T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "alpha/v1/v1.0",
                  sha: promotionHeadSha,
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.publishTransaction.exactTag, "v1.0.0");
  assert.equal(refs.get("tags/v1.0.0"), result.sha);
});

test("publish transaction resumes partial release finalization with exact tag on release material", async () => {
  const oldReleaseSha = "8".repeat(40);
  const alphaSha = "9".repeat(40);
  const versionHeadSha = "1".repeat(40);
  const previousFinalizedSha = "2".repeat(40);
  const mergeSha = "3".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
      ["tags/v1.0.0", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldReleaseSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "4".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-partial-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0");
  assert.equal(refs.get("heads/release/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1"), mergeSha);
  assert.equal(refs.has("tags/v1.0.1"), false);
});

test("publish transaction durable ref restores state and evidence in a fresh workspace", async () => {
  const sourceCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(sourceCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const transaction = {
    schema: 1,
    id: "tx-1",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: evidencePath,
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [{ kind: "npm", name: "@kungfu-tech/buildchain", ref: "1.0.0", digest: "sha256:ok", group: "", required: true }],
    evidence: [".buildchain/release-evidence/1.0.0/evidence.json"],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version: "1.0.0",
    channel: "release",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    target_ref: "release/v1/v1.0",
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    artifacts: transaction.artifacts,
  }, null, 2) + "\n");

  const { octokit } = createGitMock();
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd: sourceCwd,
    transaction,
    evidencePath,
  });

  const freshCwd = makeTempWorkspace({});
  const freshStatePath = path.join(freshCwd, ".buildchain/release-state/1.0.0.json");
  const freshEvidencePath = path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const restored = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0",
    statePath: freshStatePath,
    evidencePath: freshEvidencePath,
  });

  assert.equal(restored.id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshStatePath, "utf8")).id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshEvidencePath, "utf8")).artifacts[0].digest, "sha256:ok");
});

test("publish transaction durable ref updates when create races existing ref visibility", async () => {
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const baseTransaction = {
    schema: 1,
    id: "tx-visibility-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const orderFile = path.join(cwd, "order.log");
  const { octokit, refs } = createGitMock({ orderFile });
  const originalUpdateRef = octokit.rest.git.updateRef;
  const updateForces = [];
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    return originalUpdateRef(args);
  };

  const first = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: baseTransaction,
    evidencePath: "",
  });

  const originalGetRef = octokit.rest.git.getRef;
  let hideStateRefOnce = true;
  octokit.rest.git.getRef = async (args) => {
    if (hideStateRefOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      hideStateRefOnce = false;
      throw notFound();
    }
    return originalGetRef(args);
  };

  const second = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      ...baseTransaction,
      state: "publishing",
      previous_state: "prepared",
      updated_at: "2026-07-01T00:00:01.000Z",
    },
    evidencePath: "",
  });

  assert.notEqual(second.sha, first.sha);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), second.sha);
  assert.deepEqual(fs.readFileSync(orderFile, "utf8").trim().split("\n"), [
    "create:refs/heads/buildchain/release-state/1-0-0",
    "create:refs/heads/buildchain/release-state/1-0-0",
    "update:heads/buildchain/release-state/1-0-0",
  ]);
  assert.deepEqual(updateForces, [true]);
});

test("publish transaction durable ref rebases when update sees a newer head", async () => {
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-update-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0", SHA]]),
  });
  const racingSha = "c".repeat(40);
  const originalUpdateRef = octokit.rest.git.updateRef;
  const updateForces = [];
  let rejectOnce = true;
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    if (rejectOnce) {
      rejectOnce = false;
      refs.set("heads/buildchain/release-state/1-0-0", racingSha);
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
        response: { data: { message: "Update is not a fast forward" } },
      });
    }
    return originalUpdateRef(args);
  };

  const result = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction,
    evidencePath: "",
  });

  assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  assert.deepEqual(updateForces, [false, false]);
  assert.deepEqual(
    commits.get(result.sha).parents.map((parent) => parent.sha),
    [racingSha],
  );
});

test("publish transaction retries transient durable release-state writes", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-transient-write",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  try {
    const { octokit, refs } = createGitMock();
    const originalCreateRef = octokit.rest.git.createRef;
    let createRefCalls = 0;
    octokit.rest.git.createRef = async (args) => {
      createRefCalls += 1;
      if (createRefCalls === 1) {
        throw transientGitHubError();
      }
      return originalCreateRef(args);
    };

    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(createRefCalls, 2);
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries transient durable release-state reads", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const sourceCwd = makeTempWorkspace({});
  const freshCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const { octokit } = createGitMock();
  try {
    await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd: sourceCwd,
      transaction: {
        schema: 1,
        id: "tx-transient-read",
        repository: "kungfu-systems/buildchain",
        target_ref: "release/v1/v1.0",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        version: "1.0.0",
        exact_tag: "v1.0.0",
        channel: "release",
        line: "v1.0",
        version_strategy: "",
        lifecycle_identity: "lifecycle.publish",
        state_ref: "buildchain/release-state/1-0-0",
        state_path: statePath,
        evidence_path: "",
        state: "published",
        previous_state: "publishing",
        actor: "codex",
        run_id: "1",
        superseded_by: "",
        failure: "",
        artifacts: [],
        evidence: [],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      evidencePath: "",
    });

    const originalGetTree = octokit.rest.git.getTree;
    let getTreeCalls = 0;
    octokit.rest.git.getTree = async (args) => {
      getTreeCalls += 1;
      if (getTreeCalls === 1) {
        throw transientGitHubError("GitHub API 500: other side closed");
      }
      return originalGetTree(args);
    };

    const restored = await restoreDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      stateRef: "buildchain/release-state/1-0-0",
      statePath: path.join(freshCwd, ".buildchain/release-state/1.0.0.json"),
      evidencePath: path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json"),
    });

    assert.equal(getTreeCalls >= 2, true);
    assert.equal(restored.id, "tx-transient-read");
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction fails closed when durable state cannot be persisted", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalCreateRef = octokit.rest.git.createRef;
  octokit.rest.git.createRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      throw new Error("durable state write denied");
    }
    return originalCreateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable state write denied/,
  );

  assert.equal(fs.existsSync(path.join(cwd, "order.log")), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("publish transaction preserves post-publish failures without publish_failed transition", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:published"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let stateUpdates = 0;
  octokit.rest.git.updateRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      stateUpdates += 1;
      if (stateUpdates >= 2) {
        throw new Error("durable published state write denied");
      }
    }
    return originalUpdateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable published state write denied/,
  );

  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8");
  assert.match(order, /publish/);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("anchored manual release verifies existing anchor state and does not prepare next alpha", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.0",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      nodeCommit: "abc123",
      libnodeRevision: "kf.0",
      npmVersion: "22.22.3-kf.0",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));
const fields = JSON.parse(process.env.BUILDCHAIN_ANCHOR_MANIFEST_JSON);

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(pkg.version, "22.22.3-kf.0");
assert.equal(anchor.npmVersion, pkg.version);
assert.equal(fields.nodeTag, "v22.22.3");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const refs = new Map([["heads/release/v22/v22.22", SHA]]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.nextAlphaSha, undefined);
  assert.equal(refs.get("heads/release/v22/v22.22"), SHA);
  assert.equal(refs.get("heads/alpha/v22/v22.22"), undefined);
  assert.equal(refs.get("heads/dev/v22/v22.22"), undefined);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
  assert.equal(refs.get("tags/v22.22-alpha"), undefined);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "anchored-manual-version-state" || update.action === "next-anchor-required")
      .map((update) => [update.action, update.version || update.ref, update.manifest]),
    [
      ["anchored-manual-version-state", "22.22.0", "libnode.release.json"],
      ["next-anchor-required", "dev/v22/v22.22", "libnode.release.json"],
    ],
  );
});

test("publish-gate/major promotion publishes next major production and prepares next alpha", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.10",
      private: true,
    },
  });
  const refs = new Map([["heads/publish-gate/major", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async ({ content }) => {
          const sha = `blob-${blobs.length + 1}`;
          blobs.push({ sha, content });
          return { data: { sha } };
        },
        createTree: async ({ tree }) => ({
          data: { sha: `tree-created-${tree.map((item) => item.sha).join("-")}` },
        }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        update: async (input) => {
          repoUpdates.push(input);
          return {};
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v2/v2.0",
    },
  ]);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      ["chore(release): release v2.0.0", [SHA]],
      ["chore(release): prepare v2.0.1-alpha.0", [releaseSha]],
    ],
  );
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "2.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "2.0.1-alpha.0"')),
  );
});

test("publish-gate/major finalization opens next-alpha PR from current alpha head", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
  });
  const currentAlphaSha = OTHER_SHA;
  const refs = new Map([
    ["heads/publish-gate/major", SHA],
    ["heads/alpha/v2/v2.0", currentAlphaSha],
  ]);
  const commits = [];
  let createdPullRequest;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v2/v2.0") {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            error.response = { data: { message: "Update is not a fast forward" } };
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/major-next-alpha",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        update: async () => ({}),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), currentAlphaSha);
  assert.deepEqual(commits[1].parents, [currentAlphaSha]);
  assert.equal(
    refs.get(`heads/${versionStateBranchName("alpha/v2/v2.0", nextAlphaSha)}`),
    nextAlphaSha,
  );
  assert.equal(createdPullRequest.base, "alpha/v2/v2.0");
  assert.equal(createdPullRequest.head, versionStateBranchName("alpha/v2/v2.0", nextAlphaSha));
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
});

test("release promotion rerun reuses prepared next alpha version commit", async () => {
  const releaseSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", releaseSha],
    ["tags/v1.0.0", releaseSha],
    ["tags/v1.0.1-alpha.0", nextAlphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        createCommit: async () => {
          throw new Error("createCommit should not be called on rerun");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseSha,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    result.updates
      .filter((update) => update.version)
      .map((update) => [update.version, update.action, update.sha]),
    [
      ["1.0.0", "existing-version-state", releaseSha],
      ["1.0.1-alpha.0", "existing-version-state", nextAlphaSha],
    ],
  );
});

test("promoteBuildchainRefs rejects stale target SHA", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: OTHER_SHA } } }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
    }),
    /not requested SHA/,
  );
});

test("promoteBuildchainRefs fails fast when promote-only RC passport source is stale", async () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "alpha", ref: "alpha/v1/v1.0", version: "1.0.0-alpha.0" },
      source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          return { data: { object: { sha: SHA } } };
        },
        getCommit: async ({ commit_sha }) => {
          calls.push(["getCommit", commit_sha]);
          return { data: { tree: { sha: `tree-${commit_sha}` }, parents: [] } };
        },
        listMatchingRefs: async () => {
          calls.push(["listMatchingRefs"]);
          return { data: [] };
        },
      },
    },
  };

  try {
    await assert.rejects(
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        versionState: false,
        promoteOnlyReleaseCandidate: true,
      }),
      /release candidate passport validation failed: source identity mismatch/,
    );
    assert.deepEqual(calls, [["getRef", "heads/alpha/v1/v1.0"], ["getCommit", SHA]]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("promote-only RC passport accepts channel merge commit with matching source tree", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "alpha", ref: "alpha/v1/v1.0", version: "1.0.0-alpha.0" },
      source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  try {
    const result = validatePromotionReleaseCandidate({
      cwd,
      repository: "kungfu-systems/buildchain",
      targetChannel: "alpha",
      sourceHeadSha: SHA,
      sourceTreeSha: `tree-${SHA}`,
    });
    assert.equal(result.platformCount, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("promote-only RC passport tolerates legacy unbound target channel", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "none", ref: "", version: "source-aaaaaaaaaaaa" },
      source: { headSha: SHA, mergeRefSha: SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  try {
    const result = validatePromotionReleaseCandidate({
      cwd,
      repository: "kungfu-systems/buildchain",
      targetChannel: "alpha",
      sourceHeadSha: SHA,
      sourceTreeSha: `tree-${SHA}`,
    });
    assert.equal(result.platformCount, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("strict alpha promotion requires a protected dev-to-alpha PR", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: protectedChannel(),
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-29T00:00:00Z",
                base: { ref: "alpha/v1/v1.0" },
                head: {
                  ref: "dev/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.slice(0, 2), [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["getRef", "tags/v1.0.0-alpha.0"],
  ]);
});

test("strict alpha promotion rejects unreadable protection details", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          calls.push(["getBranchProtection", branch]);
          const error = new Error("Resource not accessible by integration");
          error.status = 403;
          throw error;
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /protection details must be readable/,
  );

  assert.deepEqual(calls, [["getBranchProtection", "alpha/v1/v1.0"]]);
});

test("strict alpha promotion rejects protection without admin enforcement", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({ enforce_admins: { enabled: false } }),
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must enforce branch protection for administrators/,
  );
});

test("strict alpha promotion rejects protection bypass surfaces", async () => {
  for (const [override, pattern] of [
    [
      { allow_force_pushes: { enabled: true } },
      /must disallow force pushes/,
    ],
    [
      { allow_deletions: { enabled: true } },
      /must disallow branch deletion/,
    ],
    [
      { required_conversation_resolution: { enabled: false } },
      /must require conversation resolution/,
    ],
  ]) {
    const octokit = {
      rest: {
        git: {
          getRef: async ({ ref }) => {
            if (ref === "heads/alpha/v1/v1.0") {
              return { data: { object: { sha: SHA } } };
            }
            throw notFound();
          },
          listMatchingRefs: async () => ({ data: [] }),
        },
        repos: {
          getBranchProtection: async () => ({
            data: protectedChannel(override),
          }),
        },
      },
    };

    await assert.rejects(
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        versionState: false,
        requireGovernance: true,
      }),
      pattern,
    );
  }
});

test("strict alpha promotion rejects missing PR lineage", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "feature/direct",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must come from a merged same-repository PR dev\/v1\/v1\.0 -> alpha\/v1\/v1\.0/,
  );
});

test("strict alpha promotion accepts same-line version-state PR lineage", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "state-sha" } }),
        listMatchingRefs: async ({ ref }) => {
          if (ref === "tags/v1.0.") {
            return { data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }] };
          }
          return { data: [] };
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-07-07T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "buildchain/version-state/alpha-v1-v1.0/123456789abc",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
});

test("strict alpha promotion accepts same-line publish-gate PR lineage", async () => {
  const pullRequest = await assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
            assert.equal(commit_sha, SHA);
            return {
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            };
          },
        },
      },
    },
    owner: "kungfu-systems",
    repo: "libnode",
    sha: SHA,
    targetRef: "alpha/v22/v22.22",
  });

  assert.equal(pullRequest.head.ref, "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15");
});

test("strict alpha promotion rejects publish-gate PR lineage for a different line", async () => {
  await assert.rejects(
    assertChannelPromotionPr({
      octokit: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.23/22.23.0-alpha.0",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "libnode",
      sha: SHA,
      targetRef: "alpha/v22/v22.22",
    }),
    /publish-gate\/alpha\/\.\.\. -> alpha\/v22\/v22\.22/,
  );
});

test("strict alpha promotion no-ops settled generated version-state commits", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.4-alpha.0", SHA],
    ["tags/v1.0-alpha", SHA],
  ]);
  const writes = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        createRef: async (args) => {
          writes.push(["createRef", args.ref]);
          return {};
        },
        updateRef: async (args) => {
          writes.push(["updateRef", args.ref]);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => {
          assert.fail("settled alpha version-state commits should not need PR lookup");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.updates, [
    { ref: "alpha/v1/v1.0", action: "already-promoted", sha: SHA },
    { ref: "dev/v1/v1.0", action: "already-promoted", sha: SHA },
    { tag: "v1.0.4-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "existing", sha: SHA },
  ]);
});

test("strict alpha promotion fails fast when direct version-state sync is not authorized", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "c".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  let createdPullRequest = false;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
            error.status = 422;
            throw error;
          }
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          createdPullRequest = true;
          throw new Error("test should not create a version-state PR");
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    () => promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      cwd,
      requireGovernance: true,
      requireVersionState: true,
    }),
    /generated version-state update.*rejected by branch protection.*without a post-publish human PR/,
  );
  assert.equal(createdPullRequest, false);
});

test("strict alpha promotion uses generated ref update token for protected version-state sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const bypassWrites = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref.startsWith("heads/")) {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
            error.status = 422;
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      checks: {
        create: async () => ({ data: { id: 1 } }),
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "release-bot" } }),
      },
      apps: {
        getAuthenticated: async () => ({ data: { slug: "buildchain-promotion" } }),
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        updateBranchProtection: async () => ({ data: {} }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };
  const refUpdateOctokit = {
    rest: {
      git: {
        updateRef: async ({ ref, sha }) => {
          bypassWrites.push(["updateRef", ref, sha]);
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          bypassWrites.push(["createRef", ref, sha]);
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  await promoteBuildchainRefs({
    octokit,
    refUpdateOctokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.deepEqual(
    bypassWrites.filter((write) => write[1].startsWith("heads/")),
    [
      ["updateRef", "heads/dev/v1/v1.0", SHA],
    ],
  );
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
  assert.equal(refs.get("heads/dev/v1/v1.0"), SHA);
});

test("strict alpha promotion protects created dev branches with one required approval", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const protections = [];
  const checkRuns = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            assert.ok(
              checkRuns.find((check) => check.head_sha === sha && check.name === "Build"),
              "generated alpha version-state check should be created before ref PATCH",
            );
          }
          if (ref === "heads/dev/v1/v1.0") {
            assert.ok(
              protections.find((protection) => protection.branch === "dev/v1/v1.0"),
              "managed dev branch protection should be updated before ref PATCH",
            );
            assert.ok(
              checkRuns.find((check) => check.head_sha === sha && check.name === "Build"),
              "generated dev version-state check should be created before ref PATCH",
            );
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      checks: {
        create: async (request) => {
          checkRuns.push(request);
          return { data: { id: checkRuns.length } };
        },
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "current-release-bot" } }),
      },
      apps: {
        getAuthenticated: async () => ({ data: { slug: "current-release-app" } }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({
            required_status_checks: { strict: true, contexts: ["Build"] },
          }),
        }),
        updateBranchProtection: async (request) => {
          protections.push(request);
          return { data: {} };
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    requiredStatusCheck: "Build",
    branchProtectionBypassApps: "github-actions, buildchain-promotion",
    branchProtectionBypassUsers: "release-bot",
    branchProtectionBypassTeams: "release-engineering",
  });

  const devProtection = protections.find(
    (protection) => protection.branch === "dev/v1/v1.0",
  );
  assert.ok(devProtection);
  assert.deepEqual(devProtection.required_status_checks, {
    strict: true,
    checks: [{ context: "Build", app_id: 15368 }],
  });
  assert.deepEqual(devProtection.required_pull_request_reviews, {
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
    require_last_push_approval: false,
    bypass_pull_request_allowances: {
      apps: ["github-actions", "buildchain-promotion", "current-release-app"],
      users: ["release-bot", "current-release-bot"],
      teams: ["release-engineering"],
    },
  });
  assert.equal(devProtection.enforce_admins, true);
  assert.equal(devProtection.allow_force_pushes, false);
  assert.equal(devProtection.allow_deletions, false);
  assert.equal(devProtection.required_conversation_resolution, true);
  assert.equal(checkRuns.length, 1);
  assert.deepEqual(
    checkRuns.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    [
      {
        name: "Build",
        status: "completed",
        conclusion: "success",
      },
    ],
  );
});

test("strict alpha promotion accepts reviewed version-state PRs from a legal parent", async () => {
  const versionSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", versionSha],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents: commit_sha === versionSha ? [{ sha: SHA }] : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "dev/v1/v1.0",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/cccccccccccc",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: versionSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, versionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), versionSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), versionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), versionSha);
});

test("strict alpha promotion accepts merged generated version-state PR commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
});

test("strict alpha promotion can advance from a generated version-state merge commit", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const nextVersionSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
    ["tags/v1.0.6-alpha.0", oldAlphaSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: nextVersionSha } }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, nextVersionSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.1"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextVersionSha);
});

test("strict alpha promotion finalizes tags when dev already advanced", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const advancedDevSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", advancedDevSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            throw Object.assign(new Error("Update is not a fast forward"), {
              status: 422,
              response: { data: { message: "Update is not a fast forward" } },
            });
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), advancedDevSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.deepEqual(
    result.updates.find(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "skipped-non-fast-forward",
    ),
    {
      ref: "dev/v1/v1.0",
      action: "skipped-non-fast-forward",
      sha: mergeSha,
      currentSha: advancedDevSha,
    },
  );
});

test("strict release promotion requires a matching alpha tree and alpha-to-release PR", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === OTHER_SHA ? "old-release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "d".repeat(40) } }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "release/v1/v1.0" },
              head: {
                ref: "alpha/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, "d".repeat(40));
  assert.equal(refs.get("tags/v1.0.2"), "d".repeat(40));
});

test("strict anchored release promotion accepts declared version file and anchor manifest changes", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.0",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.0",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(anchor.npmVersion, "22.22.3-kf.0");
assert.equal(pkg.version, anchor.npmVersion);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v22/v22.22", SHA],
    ["tags/v22.22.0-alpha.0", alphaSha],
  ]);
  const trees = new Map([
    ["alpha-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-alpha" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-alpha" },
    ]],
    ["release-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-release" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-release" },
    ]],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === alphaSha ? "alpha-tree" : "release-tree" },
            parents: commit_sha === SHA ? [{ sha: alphaSha }] : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
        }),
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data: commit_sha === SHA
            ? [
                {
                  merged_at: "2026-07-02T00:00:00Z",
                  base: { ref: "release/v22/v22.22" },
                  head: {
                    ref: "alpha/v22/v22.22",
                    repo: { full_name: "kungfu-systems/buildchain" },
                  },
                },
              ]
            : [],
        }),
        compareCommitsWithBasehead: async () => {
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "libnode.release.json" },
              ],
            },
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
});

test("strict anchored release promotion accepts reviewed target PR with only version material changes", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.3",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.3",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(anchor.npmVersion, "22.22.3-kf.3");
assert.equal(pkg.version, anchor.npmVersion);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const releaseBaseSha = "d".repeat(40);
  const featureParentSha = "e".repeat(40);
  const refs = new Map([
    ["heads/release/v22/v22.22", SHA],
    ["tags/v22.22.0-alpha.2", alphaSha],
  ]);
  const trees = new Map([
    ["alpha-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-alpha" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-alpha" },
    ]],
    ["release-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-release" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-release" },
    ]],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === alphaSha ? "alpha-tree" : "release-tree" },
            parents:
              commit_sha === SHA
                ? [{ sha: releaseBaseSha }, { sha: featureParentSha }]
                : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
        }),
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-02T00:00:00Z",
                    base: { ref: "release/v22/v22.22" },
                    head: {
                      ref: "feature/release-kf3-final-v2",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
        compareCommitsWithBasehead: async () => {
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "libnode.release.json" },
              ],
            },
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
});

test("anchored manual publish transactions use declared package version for durable state", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.verify]
command = "node scripts/verify.mjs"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.3",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.3",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(pkg.version, anchor.npmVersion);
`,
    "scripts/publish.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.3-kf.3");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    group: "libnode",
    kind: "npm",
    name: "@kungfu-tech/libnode",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha512:libnode"
  }]
}, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v22/v22.22", SHA],
      ["tags/v22.22.0-alpha.2", alphaSha],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    allowRepository: "kungfu-systems/libnode",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
    publishTransaction: true,
    releasePassportImpactJson: productionImpactJson({
      tag: "v22.22.0",
      line: "v22.22",
      rationale: "Production libnode promotion preserves the anchored Node-compatible surface.",
    }),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode",
        ref: "22.22.3-kf.3",
        digest: "sha512:libnode",
      },
    ]),
  });

  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v22.22.0");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/22-22-3-kf-3");
  assert.equal(refs.has("heads/buildchain/release-state/22-22-3-kf-3"), true);
  assert.equal(refs.has("heads/buildchain/release-state/22-22-0"), false);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
});

test("strict release promotion rejects code changes after alpha", async () => {
  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === SHA ? "release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must have the same tree as v1\.0\.2-alpha\.0/,
  );
});

test("strict release promotion accepts line-scoped buildchain recovery PRs", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2",
      packageManager: "pnpm@11.7.0",
    },
  });
  const alphaSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === alphaSha ? "alpha-tree" : "recovery-tree" },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: nextAlphaSha } }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.equal(basehead, `${alphaSha}...${SHA}`);
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "actions/promote-buildchain-ref/lib.js" },
                { filename: "actions/promote-buildchain-ref/dist/index.js" },
                { filename: "scripts/release-line-policy.mjs" },
                { filename: "tests/promote-buildchain-ref.test.mjs" },
                { filename: "tests/release-line-policy.test.mjs" },
              ],
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-01T00:00:00Z",
                    base: { ref: "release/v1/v1.0" },
                    head: {
                      ref: "fix/release-line-v1-v1.0-finalization-recovery",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(refs.get("tags/v1.0.2"), SHA);
  assert.equal(refs.get("tags/v1.0.3-alpha.0"), nextAlphaSha);
});

test("strict release promotion accepts recovery from floating alpha material after exact alpha", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const exactAlphaSha = "c".repeat(40);
  const floatingAlphaSha = "d".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", exactAlphaSha],
    ["tags/v1.0-alpha", floatingAlphaSha],
  ]);
  const { octokit, commits } = createGitMock({ refs });
  commits.set(exactAlphaSha, {
    sha: exactAlphaSha,
    tree: { sha: "exact-alpha-tree" },
    parents: [],
  });
  commits.set(floatingAlphaSha, {
    sha: floatingAlphaSha,
    tree: { sha: "floating-alpha-tree" },
    parents: [{ sha: exactAlphaSha }],
  });
  commits.set(SHA, {
    sha: SHA,
    tree: { sha: "release-recovery-tree" },
    parents: [{ sha: OTHER_SHA }, { sha: floatingAlphaSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      if (basehead === `${floatingAlphaSha}...${SHA}`) {
        return {
          data: {
            files: [
              { filename: "actions/promote-buildchain-ref/lib.js" },
              { filename: "actions/promote-buildchain-ref/dist/index.js" },
              { filename: "tests/promote-buildchain-ref.test.mjs" },
            ],
          },
        };
      }
      if (basehead.startsWith(`${SHA}...commit-`)) {
        return { data: { files: [{ filename: "package.json" }] } };
      }
      throw new Error(`unexpected comparison ${basehead}`);
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === SHA
          ? [
              {
                merged_at: "2026-07-01T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "fix/release-line-v1-v1.0-finalization-recovery",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.match(result.sha, /^commit-/);
  assert.equal(refs.get("tags/v1.0.2"), result.sha);
  assert.match(refs.get("tags/v1.0.3-alpha.0"), /^commit-/);
});

test("strict promotion rejects repositories without version state", async () => {
  const cwd = makeTempWorkspace({ "README.md": "no package state\n" });
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      cwd,
      requireVersionState: true,
    }),
    /requires package version state/,
  );
});
