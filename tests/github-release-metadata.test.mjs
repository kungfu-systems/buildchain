import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReleaseTag,
  ensureGitHubRelease,
} from "../scripts/ensure-github-release.mjs";

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Buildchain alpha releases are prereleases and never latest", () => {
  assert.deepEqual(classifyReleaseTag("v2.6.2-alpha.0"), {
    tag: "v2.6.2-alpha.0",
    prerelease: true,
    makeLatest: "false",
  });
});

test("semver prerelease tags are prereleases and never latest", () => {
  assert.deepEqual(classifyReleaseTag("v22.22.3-kf.3-alpha.7"), {
    tag: "v22.22.3-kf.3-alpha.7",
    prerelease: true,
    makeLatest: "false",
  });
  assert.deepEqual(classifyReleaseTag("v1.2.3-rc.1"), {
    tag: "v1.2.3-rc.1",
    prerelease: true,
    makeLatest: "false",
  });
});

test("Buildchain stable releases become the latest release", () => {
  assert.deepEqual(classifyReleaseTag("v2.6.1"), {
    tag: "v2.6.1",
    prerelease: false,
    makeLatest: "true",
  });
});

test("unsupported release tags fail closed", () => {
  assert.throws(() => classifyReleaseTag("v2.6-alpha"), /Unsupported semver release tag/);
  assert.throws(() => classifyReleaseTag("latest"), /Unsupported semver release tag/);
});

test("ensureGitHubRelease creates alpha releases with explicit metadata", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (String(url).endsWith("/releases/tags/v2.6.2-alpha.0")) {
      return jsonResponse({ message: "Not Found" }, { status: 404 });
    }
    if (String(url).endsWith("/git/ref/tags/v2.6.2-alpha.0")) {
      return jsonResponse({ object: { sha: "a".repeat(40) } });
    }
    if (String(url).endsWith("/releases") && options.method === "POST") {
      return jsonResponse({ id: 123, tag_name: "v2.6.2-alpha.0" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };

  const result = await ensureGitHubRelease({
    apiUrl: "https://api.github.test",
    token: "token",
    repository: "kungfu-systems/buildchain",
    tag: "v2.6.2-alpha.0",
    title: "v2.6.2-alpha.0",
    notes: "notes",
  });

  assert.equal(result.action, "created");
  assert.equal(requests.at(-1).method, "POST");
  assert.deepEqual(requests.at(-1).body, {
    tag_name: "v2.6.2-alpha.0",
    name: "v2.6.2-alpha.0",
    body: "notes",
    prerelease: true,
    make_latest: "false",
  });
});

test("ensureGitHubRelease patches stable releases with latest metadata", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (String(url).endsWith("/releases/tags/v2.6.1")) {
      return jsonResponse({ id: 456, name: "v2.6.1" });
    }
    if (String(url).endsWith("/releases/456") && options.method === "PATCH") {
      return jsonResponse({ id: 456, tag_name: "v2.6.1" });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };

  const result = await ensureGitHubRelease({
    apiUrl: "https://api.github.test",
    token: "token",
    repository: "kungfu-systems/buildchain",
    tag: "v2.6.1",
  });

  assert.equal(result.action, "updated");
  assert.equal(requests.at(-1).method, "PATCH");
  assert.deepEqual(requests.at(-1).body, {
    name: "v2.6.1",
    prerelease: false,
    make_latest: "true",
  });
});
