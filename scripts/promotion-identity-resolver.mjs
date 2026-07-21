#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalized(value) {
  return String(value ?? "").trim();
}

function requireSha(value, label) {
  const sha = normalized(value).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be an exact 40-character SHA`);
  return sha;
}

export async function resolvePromotionIdentities({
  routerRef,
  routerSha,
  shellRef,
  shellCallRef,
  runtimeRef,
  resolveRef,
} = {}) {
  const requested = {
    router: normalized(routerRef),
    shell: normalized(shellRef),
    shellCall: normalized(shellCallRef),
    runtime: normalized(runtimeRef),
  };
  if (Object.values(requested).some((value) => !value)) {
    throw new Error("router, shell, shell call, and runtime refs are required");
  }
  if (typeof resolveRef !== "function") throw new Error("resolveRef must be a function");

  const immutableRouterSha = requireSha(routerSha, "router SHA");
  const resolved = new Map([[requested.router, immutableRouterSha]]);
  const resolveOnce = async (ref) => {
    if (SHA_PATTERN.test(ref)) return ref.toLowerCase();
    if (!resolved.has(ref)) {
      resolved.set(ref, requireSha(await resolveRef(ref), `resolved SHA for ${ref}`));
    }
    return resolved.get(ref);
  };

  return {
    routerRef: requested.router,
    routerSha: immutableRouterSha,
    shellRef: requested.shell,
    shellSha: await resolveOnce(requested.shellCall),
    runtimeRef: requested.runtime,
    runtimeSha: await resolveOnce(requested.runtime),
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return values;
}

function repositoryParts(value) {
  const match = normalized(value).match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error("repository must use owner/name form");
  return { owner: match[1], repo: match[2] };
}

async function githubCommitResolver({ repository, token }) {
  const { owner, repo } = repositoryParts(repository);
  return async (ref) => {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kungfu-buildchain-promotion-router",
        },
      },
    );
    if (!response.ok) throw new Error(`unable to resolve ${ref}: GitHub API returned ${response.status}`);
    return (await response.json()).sha;
  };
}

function writeOutputs(file, identities) {
  const outputs = {
    "router-sha": identities.routerSha,
    "shell-sha": identities.shellSha,
    "runtime-sha": identities.runtimeSha,
  };
  fs.appendFileSync(file, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = normalized(process.env.GITHUB_TOKEN);
  if (!token) throw new Error("GITHUB_TOKEN is required to resolve floating promotion refs");
  const identities = await resolvePromotionIdentities({
    routerRef: args["router-ref"],
    routerSha: args["router-sha"],
    shellRef: args["shell-ref"],
    shellCallRef: args["shell-call-ref"],
    runtimeRef: args["runtime-ref"],
    resolveRef: await githubCommitResolver({ repository: args.repository, token }),
  });
  if (process.env.GITHUB_OUTPUT) writeOutputs(process.env.GITHUB_OUTPUT, identities);
  process.stdout.write(`${JSON.stringify(identities, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`promotion-identity-resolver: ${error.message}`);
    process.exitCode = 1;
  });
}
