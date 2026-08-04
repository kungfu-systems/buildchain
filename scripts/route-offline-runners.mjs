#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  resolveRunnerMatrix,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";

export const HOSTED_RUNNER_FALLBACKS = Object.freeze({
  "linux-x64": '["ubuntu-24.04"]',
  "macos-arm64": '["macos-15"]',
  "windows-x64": '["windows-2022"]',
});

function runnerLabels(runner) {
  const labels = JSON.parse(String(runner || "[]"));
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("runner must be a JSON array of label strings");
  }
  return labels;
}

function runnerHasLabels(runner, requiredLabels) {
  const labels = new Set(
    (runner.labels || []).map((label) => String(label?.name || label)),
  );
  return requiredLabels.every((label) => labels.has(label));
}

export function routeOfflineRunners({
  platforms,
  runners,
  fallbacks = HOSTED_RUNNER_FALLBACKS,
}) {
  const routes = [];
  const routedPlatforms = platforms.map((platform) => {
    const requiredLabels = runnerLabels(platform.runner);
    if (!requiredLabels.includes("self-hosted")) {
      routes.push({
        id: platform.id,
        status: "hosted",
        selected: "declared-runner",
      });
      return platform;
    }
    const matching = runners.filter((runner) =>
      runnerHasLabels(runner, requiredLabels),
    );
    const online = matching.filter((runner) => runner.status === "online");
    const busyOnline = online.filter((runner) => runner.busy);
    const fallbackRunner = fallbacks[platform.id] || "";
    const offline = online.length === 0;
    const selected =
      offline && fallbackRunner
        ? "github-hosted-offline-fallback"
        : "self-hosted";
    routes.push({
      id: platform.id,
      status: offline ? "offline" : "online",
      selected,
      matchingRunnerCount: matching.length,
      onlineRunnerCount: online.length,
      busyOnlineRunnerCount: busyOnline.length,
      fallbackAvailable: Boolean(fallbackRunner),
    });
    if (selected !== "github-hosted-offline-fallback") {
      return platform;
    }
    return {
      ...platform,
      runner: fallbackRunner,
      githubHosted: true,
    };
  });
  return {
    platforms: routedPlatforms,
    platformsJson: JSON.stringify(routedPlatforms),
    fallbackCount: routes.filter(
      (route) => route.selected === "github-hosted-offline-fallback",
    ).length,
    routing: {
      schema: "buildchain.runner-offline-routing/v1",
      status: "observed",
      routes,
    },
  };
}

async function fetchGitHubJson({ url, token, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `runner inventory request failed with status ${response.status}`,
    );
  }
  return response.json();
}

export async function listRepositoryRunners({
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const repositoryPayload = await fetchGitHubJson({
    url: `${apiUrl}/repos/${repository}`,
    token,
    fetchImpl,
  });
  const ownerLogin = String(repositoryPayload?.owner?.login || "").trim();
  const ownerType = String(repositoryPayload?.owner?.type || "").trim();
  const inventoryPath =
    ownerType === "Organization" && ownerLogin
      ? `/orgs/${ownerLogin}/actions/runners`
      : `/repos/${repository}/actions/runners`;
  const runners = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchGitHubJson({
      url: `${apiUrl}${inventoryPath}?per_page=100&page=${page}`,
      token,
      fetchImpl,
    });
    const pageRunners = Array.isArray(payload.runners) ? payload.runners : [];
    runners.push(...pageRunners);
    if (pageRunners.length < 100) {
      return {
        runners,
        inventoryScope:
          ownerType === "Organization" && ownerLogin
            ? "organization"
            : "repository",
      };
    }
  }
}

export async function resolveOfflineRunnerFallback({
  runnerPreset,
  platformsJson = "",
  repository,
  token,
  apiUrl,
  fetchImpl,
}) {
  const base = resolveRunnerMatrix({ runnerPreset, platformsJson });
  const selfHosted = base.platforms.filter((platform) =>
    runnerLabels(platform.runner).includes("self-hosted"),
  );
  if (selfHosted.length === 0) {
    return {
      platformsJson: base.platformsJson,
      fallbackCount: 0,
      routing: {
        schema: "buildchain.runner-offline-routing/v1",
        status: "not-applicable",
        routes: [],
      },
    };
  }
  if (!String(token || "").trim()) {
    return {
      platformsJson: base.platformsJson,
      fallbackCount: 0,
      routing: {
        schema: "buildchain.runner-offline-routing/v1",
        status: "unavailable",
        reason: "runner-inventory-token-not-projected",
        routes: [],
      },
    };
  }
  try {
    const inventory = await listRepositoryRunners({
      repository,
      token,
      apiUrl,
      fetchImpl,
    });
    const routed = routeOfflineRunners({
      platforms: base.platforms,
      runners: inventory.runners,
    });
    return {
      ...routed,
      routing: {
        ...routed.routing,
        inventoryScope: inventory.inventoryScope,
      },
    };
  } catch {
    return {
      platformsJson: base.platformsJson,
      fallbackCount: 0,
      routing: {
        schema: "buildchain.runner-offline-routing/v1",
        status: "unavailable",
        reason: "runner-inventory-unavailable",
        routes: [],
      },
    };
  }
}

async function main() {
  const resolved = await resolveOfflineRunnerFallback({
    runnerPreset: process.env.BUILDCHAIN_RUNNER_PRESET || "github-hosted",
    platformsJson: process.env.BUILDCHAIN_PLATFORMS_JSON || "",
    repository: process.env.GITHUB_REPOSITORY || "",
    token: process.env.BUILDCHAIN_RUNNER_INVENTORY_TOKEN || "",
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
  });
  writeGitHubOutputs({
    "platforms-json": resolved.platformsJson,
    "fallback-count": String(resolved.fallbackCount),
    "routing-json": JSON.stringify(resolved.routing),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`,
    );
    process.exitCode = 1;
  });
}
