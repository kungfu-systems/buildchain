import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import { assertPipelineStableQualification } from "../packages/core/publication/pipeline/stable.js";
import { readPipelineStableSource } from "../packages/core/providers/github/pipeline-stable-source.js";
import { stableBaselineFixture } from "./helpers/pipeline-stable-baseline.mjs";

const repository = "example/product",
  base = `/repos/${repository}`;
const alpha = "a".repeat(40),
  alphaTree = "b".repeat(40),
  previous = "c".repeat(40),
  previousTree = "d".repeat(40);
const configPath = ".buildchain/buildchain.toml",
  impactPath = "product/impact.json";
const alphaTag = "v1.1.0-alpha.1",
  stableTag = "v1.0.0";

function blob(value) {
  const bytes = Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return {
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}

function release(tag, id, publishedAt, prerelease = false) {
  return {
    id,
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: publishedAt,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
  };
}

function fixture() {
  const config = parse(
    fs.readFileSync(
      "templates/minimal-consumer/npm/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  config.channels = config.channels.map((route) => ({
    ...route,
    from: route.from.replace("v1.0", "v1.1"),
    to: route.to.replace("v1.0", "v1.1"),
  }));
  config.stable = {
    minimum_interval_seconds: 86400,
    minimum_soak_seconds: 3600,
    product_paths: ["src/"],
    impact_file: impactPath,
    require_published_entry: true,
  };
  const configBytes = stringify(config),
    configBlob = blob(configBytes);
  const pkg = blob({ name: "@example/product", version: "1.1.0-alpha.1" });
  const impact = blob({
    release: { version: "1.1.0-alpha.1" },
    summary: "Product changes",
    surfaceImpacts: [{ id: "product-api" }],
  });
  const product = blob("export const version = 2;\n");
  const entries = [
    [configPath, configBlob],
    ["package.json", pkg],
    [impactPath, impact],
    ["src/product.js", product],
  ].map(([path, value]) => ({
    path,
    sha: value.sha,
    type: "blob",
    mode: "100644",
  }));
  const source = bindConsumerSource(
    {
      repository,
      commit: alpha,
      tree: alphaTree,
      configPath,
      configBlob: configBlob.sha,
    },
    configBytes,
  );
  const plan = planPipelinePublication({
    attempt: `attempt-${"1".repeat(64)}`,
    generation: `generation-${"2".repeat(64)}`,
    source: { ...source.identity, commit: "e".repeat(40) },
    intentSource: source.identity,
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: "f".repeat(40),
      tree: "1".repeat(40),
    },
    publisher: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/.release-pipeline-products.yml",
      workflowSha: "f".repeat(40),
      job: "apply",
    },
    contract: source.plan,
    route: source.plan.channels[2],
    version: "1.1.0-alpha.1",
    sourceTimestamp: "2026-09-13T00:00:00Z",
    previousChannelCommit: previous,
  });
  const alphaRelease = release(alphaTag, 11, "2026-09-13T00:00:00Z", true);
  const stableRelease = release(stableTag, 10, "2026-09-11T00:00:00Z");
  const routes = new Map([
    [
      `/git/ref/tags/${alphaTag}`,
      { ref: `refs/tags/${alphaTag}`, object: { type: "commit", sha: alpha } },
    ],
    [
      `/git/ref/tags/${stableTag}`,
      {
        ref: `refs/tags/${stableTag}`,
        object: { type: "commit", sha: previous },
      },
    ],
    [`/releases/tags/${alphaTag}`, alphaRelease],
    ["/releases/11/assets?per_page=100&page=1", []],
    ["/releases?per_page=100&page=1", [alphaRelease, stableRelease]],
    [
      `/git/commits/${alpha}`,
      {
        sha: alpha,
        tree: { sha: alphaTree },
        committer: { date: "2026-09-13T00:00:00Z" },
      },
    ],
    [
      `/git/commits/${previous}`,
      { sha: previous, tree: { sha: previousTree } },
    ],
    [
      `/git/trees/${alphaTree}?recursive=1`,
      { sha: alphaTree, truncated: false, tree: entries },
    ],
    [
      `/git/trees/${previousTree}?recursive=1`,
      {
        sha: previousTree,
        truncated: false,
        tree: entries.map((entry) =>
          entry.path === "src/product.js"
            ? { ...entry, sha: "2".repeat(40) }
            : { ...entry },
        ),
      },
    ],
    [`/contents/${configPath}?ref=${alpha}`, configBlob],
  ]);
  for (const value of [configBlob, pkg, impact, product])
    routes.set(`/git/blobs/${value.sha}`, value);
  const calls = [],
    counts = new Map();
  const host = {
    repository,
    async request(endpoint, options = {}) {
      assert.equal(
        options.method || "GET",
        "GET",
        "source collection must not write",
      );
      assert.ok(endpoint.startsWith(`${base}/`));
      const key = endpoint.slice(base.length);
      assert.ok(routes.has(key), `unexpected request ${key}`);
      calls.push(key);
      counts.set(key, (counts.get(key) || 0) + 1);
      const value = routes.get(key);
      return structuredClone(
        typeof value === "function" ? value(counts.get(key)) : value,
      );
    },
  };
  return {
    plan,
    host,
    routes,
    calls,
    counts,
    entries,
    impact,
    alphaRelease,
    stableRelease,
  };
}

test("stable facts bind exact Alpha blobs and complete product trees without a mutable local checkout", async () => {
  const f = fixture(),
    result = await readPipelineStableSource(f.plan, f.host);
  const { root, ...body } = result;
  assert.equal(root, recordDigest(body));
  assert.equal(result.planRoot, f.plan.root);
  assert.equal(result.candidate.sha, alpha);
  assert.equal(result.previousStable.sha, previous);
  assert.equal(result.impact.blob, f.impact.sha);
  assert.equal(result.impact.value.release.version, "1.1.0-alpha.1");
  assert.deepEqual(result.changedPaths, ["src/product.js"]);
  assert.ok(!f.calls.some((key) => key.startsWith("/compare/")));
  assert.equal(f.counts.get(`/git/ref/tags/${alphaTag}`), 2);
});

test("completed legacy floating promotion preserves exact-tag product comparison and rechecks evidence", async () => {
  const f = fixture(),
    legacy = await stableBaselineFixture();
  const { root, ...body } = f.plan;
  body.previousChannelCommit = legacy.plan.previousChannelCommit;
  f.plan = { ...body, root: recordDigest(body) };
  const original = f.host.request;
  f.host.request = (endpoint, options) =>
    endpoint.includes("/releases/10/assets?")
      ? legacy.host.request(endpoint, options)
      : original(endpoint, options);
  f.host.github = legacy.host.github;
  const result = await readPipelineStableSource(f.plan, f.host);
  assert.equal(result.comparisonStable.sha, previous);
  assert.equal(result.comparisonStable.tree, previousTree);
  assert.equal(
    result.comparisonChannel.channelCommit,
    legacy.plan.previousChannelCommit,
  );
  assert.deepEqual(result.changedPaths, ["src/product.js"]);
  assert.equal(legacy.calls.length, 4);
});

test("complete trees include additions, removals and mode changes beyond a short diff listing", async () => {
  const f = fixture();
  const before = f.routes.get(`/git/trees/${previousTree}?recursive=1`).tree;
  const after = f.routes.get(`/git/trees/${alphaTree}?recursive=1`).tree;
  for (let i = 0; i < 350; i++) {
    const entry = {
      path: `docs/${i}.md`,
      type: "blob",
      mode: "100644",
      sha: "3".repeat(40),
    };
    before.push({ ...entry });
    after.push({ ...entry, sha: "4".repeat(40) });
  }
  before.push({
    path: "src/removed.js",
    type: "blob",
    mode: "100644",
    sha: "5".repeat(40),
  });
  after.push({
    path: "src/added.js",
    type: "blob",
    mode: "100644",
    sha: "6".repeat(40),
  });
  after.find((entry) => entry.path === "package.json").mode = "100755";
  const result = await readPipelineStableSource(f.plan, f.host);
  assert.equal(result.changedPaths.length, 354);
  for (const pathname of [
    "src/removed.js",
    "src/added.js",
    "package.json",
    "src/product.js",
  ])
    assert.ok(result.changedPaths.includes(pathname));
});

test("source metadata cannot substitute for product or post-publication entry qualification", async () => {
  const f = fixture();
  await assert.rejects(
    assertPipelineStableQualification(f.plan, f.host, {
      now: "2026-09-13T02:00:00Z",
    }),
    (error) => {
      assert.ok(error.eligibility, error.stack);
      const { report, source, root, ...body } = error.eligibility;
      assert.equal(root, recordDigest({ ...body, report, source }));
      assert.equal(report.ok, false);
      assert.ok(
        report.summary.failedChecks.includes("stable.canary.product-build"),
      );
      assert.ok(
        report.summary.failedChecks.includes("stable.canary.published-entry"),
      );
      assert.ok(report.summary.failedChecks.includes("stable.canary_soak"));
      for (const id of [
        "stable.minimum_interval",
        "stable.product_diff",
        "stable.impact",
        "stable.impact_version",
      ])
        assert.equal(
          report.checks.find((check) => check.id === id).status,
          "pass",
        );
      return true;
    },
  );
});

test("first stable compares the full product tree, while an unproved prior channel fails closed", async () => {
  const f = fixture();
  f.routes.set("/releases?per_page=100&page=1", [f.alphaRelease]);
  await assert.rejects(
    readPipelineStableSource(f.plan, f.host),
    /retained published channel/,
  );
  const { root, ...body } = f.plan;
  body.previousChannelCommit = null;
  f.plan = { ...body, root: recordDigest(body) };
  const result = await readPipelineStableSource(f.plan, f.host);
  assert.equal(result.previousStable, null);
  assert.deepEqual(
    result.changedPaths,
    f.entries.map((entry) => entry.path).sort(),
  );
});

test("tag, release and policy drift fail before source facts can qualify a candidate", async () => {
  const cases = [
    (f) => {
      f.routes.get(`/git/ref/tags/${alphaTag}`).object.sha = previous;
    },
    (f) => {
      f.alphaRelease.draft = true;
    },
    (f) => {
      f.alphaRelease.prerelease = false;
    },
    (f) => {
      f.alphaRelease.html_url =
        "https://github.com/foreign/product/releases/tag/" + alphaTag;
    },
    (f) => {
      f.routes.get(`/git/commits/${alpha}`).sha = previous;
    },
    (f) => {
      f.routes.get(`/git/trees/${alphaTree}?recursive=1`).truncated = true;
    },
    (f) => {
      f.routes
        .get(`/git/trees/${previousTree}?recursive=1`)
        .tree.push(f.entries[0]);
    },
    (f) => {
      f.entries.find((entry) => entry.path === impactPath).mode = "120000";
    },
    (f) => {
      f.routes.get(`/git/blobs/${f.impact.sha}`).content =
        Buffer.from("{}").toString("base64");
    },
    (f) => {
      f.routes
        .get("/releases?per_page=100&page=1")
        .push({ ...f.stableRelease });
    },
    (f) => {
      f.routes
        .get("/releases?per_page=100&page=1")
        .push(release("v1.2.0", 12, "2026-09-13T01:00:00Z"));
    },
  ];
  for (const mutate of cases) {
    const f = fixture();
    mutate(f);
    await assert.rejects(readPipelineStableSource(f.plan, f.host));
  }
});

test("an independently valid impact blob from another Alpha is still rejected", async () => {
  const f = fixture(),
    stale = blob({
      release: { version: "1.1.0-alpha.0" },
      summary: "Old",
      surfaceImpacts: [{ id: "product" }],
    });
  f.entries.find((entry) => entry.path === impactPath).sha = stale.sha;
  f.routes.set(`/git/blobs/${stale.sha}`, stale);
  await assert.rejects(
    readPipelineStableSource(f.plan, f.host),
    /exact Alpha version/,
  );
});

test("fresh re-read rejects a tag or public-release timestamp changed during collection", async () => {
  for (const kind of ["tag", "release"]) {
    const f = fixture();
    if (kind === "tag") {
      const original = f.routes.get(`/git/ref/tags/${alphaTag}`);
      f.routes.set(`/git/ref/tags/${alphaTag}`, (count) =>
        count === 1
          ? original
          : { ...original, object: { type: "commit", sha: previous } },
      );
    } else
      f.routes.set(`/releases/tags/${alphaTag}`, (count) =>
        count === 1
          ? f.alphaRelease
          : { ...f.alphaRelease, published_at: "2026-09-13T00:01:00Z" },
      );
    await assert.rejects(
      readPipelineStableSource(f.plan, f.host),
      /changed during provider readback/,
    );
  }
});

test("stable history is fully paged and recent backports preserve the cooldown", async () => {
  const f = fixture();
  const recent = release("v1.0.0", 10, "2026-09-13T01:30:00Z");
  const page = Array.from({ length: 99 }, (_, i) =>
    release(`v9.0.0-alpha.${i}`, 100 + i, "2026-09-10T00:00:00Z", true),
  );
  f.routes.set("/releases?per_page=100&page=1", [f.alphaRelease, ...page]);
  f.routes.set("/releases?per_page=100&page=2", [recent]);
  await assert.rejects(
    assertPipelineStableQualification(f.plan, f.host, {
      now: "2026-09-13T02:00:00Z",
    }),
    (error) => {
      assert.ok(error.eligibility, error.stack);
      assert.ok(
        error.eligibility.report.summary.failedChecks.includes(
          "stable.minimum_interval",
        ),
      );
      assert.equal(error.eligibility.source.previousStable.id, 10);
      return true;
    },
  );
  assert.equal(f.counts.get("/releases?per_page=100&page=2"), 2);
});

test("an annotated Alpha tag is checked through its immutable object and rejects object substitution", async () => {
  const f = fixture(),
    annotated = "7".repeat(40);
  f.routes.get(`/git/ref/tags/${alphaTag}`).object = {
    type: "tag",
    sha: annotated,
  };
  f.routes.set(`/git/tags/${annotated}`, {
    sha: annotated,
    object: { type: "commit", sha: alpha },
  });
  assert.equal(
    (await readPipelineStableSource(f.plan, f.host)).candidate.sha,
    alpha,
  );
  f.routes.set(`/git/tags/${annotated}`, {
    sha: "8".repeat(40),
    object: { type: "commit", sha: alpha },
  });
  await assert.rejects(
    readPipelineStableSource(f.plan, f.host),
    /annotated tag identity/,
  );
});

test("independent source reads cannot disagree about the tree of one Alpha SHA", async () => {
  const f = fixture(),
    endpoint = `/git/commits/${alpha}`;
  const original = f.routes.get(endpoint);
  f.routes.set(endpoint, (count) =>
    count < 3 ? original : { ...original, tree: { sha: previousTree } },
  );
  await assert.rejects(
    readPipelineStableSource(f.plan, f.host),
    /Alpha tree changed/,
  );
});

test("same-version recovery does not count its own completed release as the predecessor", async () => {
  const f = fixture();
  f.routes
    .get("/releases?per_page=100&page=1")
    .push(release("v1.1.0", 12, "2026-09-13T01:00:00Z"));
  const result = await readPipelineStableSource(f.plan, f.host);
  assert.equal(result.previousStable.tag, stableTag);
  assert.equal(result.comparisonStable.sha, previous);
});

test("cooldown follows the latest publication while product comparison retains the highest prior version", async () => {
  const f = fixture(),
    backportSha = "9".repeat(40);
  f.stableRelease.published_at = "2026-09-13T01:30:00Z";
  f.routes.get(`/git/ref/tags/${stableTag}`).object.sha = backportSha;
  f.routes
    .get("/releases?per_page=100&page=1")
    .push(release("v1.0.1", 12, "2026-09-11T00:00:00Z"));
  f.routes.set("/git/ref/tags/v1.0.1", {
    ref: "refs/tags/v1.0.1",
    object: { type: "commit", sha: previous },
  });
  const result = await readPipelineStableSource(f.plan, f.host);
  assert.equal(result.previousStable.sha, backportSha);
  assert.equal(result.comparisonStable.sha, previous);
  assert.equal(result.comparisonStable.tag, "v1.0.1");
});

test("foreign repository or modified plan is rejected before any provider request", async () => {
  const f = fixture();
  await assert.rejects(
    readPipelineStableSource(f.plan, {
      ...f.host,
      repository: "foreign/product",
    }),
    /exact repository/,
  );
  await assert.rejects(
    readPipelineStableSource(
      { ...f.plan, previousChannelCommit: null },
      f.host,
    ),
    /retained root/,
  );
  assert.equal(f.calls.length, 0);
});
