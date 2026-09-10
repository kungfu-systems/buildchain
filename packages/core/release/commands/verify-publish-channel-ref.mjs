import { verifyPublishChannelSource } from "../source/channel.js";
import { pathToFileURL } from "node:url";
import { resolvePublishChannelTargetRef } from "../source/coordinates.js";
import { verifyPublishChannelPrLineage, verifyPublishChannelRef } from "../source/lineage.js";
import {
  normalizeSourceRef,
  resolvePublishSourceRefSha,
} from "./publish-source-ref-resolver.mjs";

function readEnv(env, name, fallback = "") {
  return env[name] || fallback;
}

function splitRepository(repository) {
  const value = String(repository || "").trim();
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`BUILDCHAIN_SOURCE_REPOSITORY must be owner/repo, got: ${value || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2] };
}

async function resolveAssociatedPullRequests({
  repository,
  sha,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to verify publish channel PR lineage through GitHub REST API");
  }
  const { owner, repo } = splitRepository(repository);
  const apiBase = String(readEnv(env, "GITHUB_API_URL", "https://api.github.com")).replace(/\/+$/, "");
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "buildchain-publish-channel-verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = readEnv(env, "GITHUB_TOKEN");
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(url, { headers });
  if (!response?.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.message ? `: ${body.message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`publish channel PR lineage could not be read for ${sha} (GitHub API ${response?.status || "unknown"}${detail})`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("publish channel PR lineage response must be an array");
  }
  return body;
}

export async function verifyPublishChannelRefCli({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sourceRef = normalizeSourceRef(readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_REF"));
  const sourceSha = readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_SHA");
  return verifyPublishChannelSource({ sourceRef, sourceSha,
    targetRef: readEnv(env, "BUILDCHAIN_PUBLISH_TARGET_REF"), repository: readEnv(env, "BUILDCHAIN_SOURCE_REPOSITORY", readEnv(env, "GITHUB_REPOSITORY")),
    targetSha: readEnv(env, "BUILDCHAIN_CURRENT_TARGET_SHA"), pullRequests: readEnv(env, "BUILDCHAIN_CURRENT_TARGET_PULLS_JSON") ? JSON.parse(env.BUILDCHAIN_CURRENT_TARGET_PULLS_JSON) : undefined,
  }, { resolveRefSha: request => resolvePublishSourceRefSha({ ...request, env, fetchImpl }), listPullRequests: request => resolveAssociatedPullRequests({ ...request, env, fetchImpl }) });

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyPublishChannelRefCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
