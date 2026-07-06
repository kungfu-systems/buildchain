#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export function classifyReleaseTag(tag) {
  const normalized = String(tag || "").trim();
  const match = normalized.match(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/);
  if (!match) {
    throw new Error(`Unsupported semver release tag: ${tag}`);
  }
  const prerelease = normalized.includes("-");
  return {
    tag: normalized,
    prerelease,
    makeLatest: prerelease ? "false" : "true",
  };
}

function parseArgs(argv) {
  const args = {
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    repository: process.env.GITHUB_REPOSITORY || "",
    tag: "",
    title: "",
    notes: "",
    target: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };
    if (arg === "--repository") args.repository = readValue();
    else if (arg === "--tag") args.tag = readValue();
    else if (arg === "--title") args.title = readValue();
    else if (arg === "--notes") args.notes = readValue();
    else if (arg === "--target") args.target = readValue();
    else if (arg === "--api-url") args.apiUrl = readValue();
    else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "usage: node scripts/ensure-github-release.mjs --repository <owner/repo> --tag <tag>",
    "",
    "Ensures Buildchain GitHub Release metadata is deterministic:",
    "- vX.Y.Z-alpha.N => prerelease=true, make_latest=false",
    "- vX.Y.Z => prerelease=false, make_latest=true",
  ].join("\n");
}

function requireToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  }
  return token;
}

function splitRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error("--repository must be in owner/repo form");
  }
  return { owner: match[1], repo: match[2] };
}

async function githubRequest({ apiUrl, token, method = "GET", path, body }) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404) {
    return { status: 404, data: undefined };
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed with ${response.status}: ${data?.message || text}`,
    );
  }
  return { status: response.status, data };
}

export async function ensureGitHubRelease({
  apiUrl = "https://api.github.com",
  token,
  repository,
  tag,
  title = "",
  notes = "",
  target = "",
} = {}) {
  const { owner, repo } = splitRepository(repository);
  const metadata = classifyReleaseTag(tag);
  const encodedTag = encodeURIComponent(metadata.tag);
  const releasePath = `/repos/${owner}/${repo}/releases/tags/${encodedTag}`;
  const refPath = `/repos/${owner}/${repo}/git/ref/tags/${encodedTag}`;
  const existing = await githubRequest({ apiUrl, token, path: releasePath });
  if (existing.status === 404) {
    const tagRef = await githubRequest({ apiUrl, token, path: refPath });
    if (tagRef.status === 404) {
      throw new Error(`Git tag ${metadata.tag} does not exist in ${repository}`);
    }
    const created = await githubRequest({
      apiUrl,
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/releases`,
      body: {
        tag_name: metadata.tag,
        name: title || metadata.tag,
        body: notes || `Buildchain release passport assets for ${metadata.tag}.`,
        prerelease: metadata.prerelease,
        make_latest: metadata.makeLatest,
        ...(target ? { target_commitish: target } : {}),
      },
    });
    return { action: "created", release: created.data, metadata };
  }
  const patched = await githubRequest({
    apiUrl,
    token,
    method: "PATCH",
    path: `/repos/${owner}/${repo}/releases/${existing.data.id}`,
    body: {
      name: title || existing.data.name || metadata.tag,
      prerelease: metadata.prerelease,
      make_latest: metadata.makeLatest,
    },
  });
  return { action: "updated", release: patched.data, metadata };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await ensureGitHubRelease({
    apiUrl: args.apiUrl,
    token: requireToken(),
    repository: args.repository,
    tag: args.tag,
    title: args.title,
    notes: args.notes,
    target: args.target,
  });
  console.log(`github-release-${result.action}=${result.metadata.tag}`);
  console.log(`github-release-prerelease=${result.metadata.prerelease}`);
  console.log(`github-release-make-latest=${result.metadata.makeLatest}`);
}

function isCliEntrypoint() {
  const entry = process.argv[1] || "";
  return (
    entry.replace(/\\/g, "/").endsWith("/ensure-github-release.mjs") &&
    import.meta.url === pathToFileURL(entry).href
  );
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
