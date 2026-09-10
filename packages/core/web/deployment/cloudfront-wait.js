import { spawnSync } from "node:child_process";

export function argValue(args = [], name = "") {
  const index = args.indexOf(name);
  return index === -1 ? "" : String(args[index + 1] || "");
}

export function cloudFrontInvalidationWaitTargets(result = {}) {
  const targets = [];
  const seen = new Set();
  for (const operation of result.operations || []) {
    if (
      operation.action !== "invalidate-cdn" ||
      operation.status !== "applied"
    ) {
      continue;
    }
    const args = Array.isArray(operation.args) ? operation.args : [];
    if (args[0] !== "cloudfront" || args[1] !== "create-invalidation") {
      continue;
    }
    const distributionId = argValue(args, "--distribution-id");
    if (!distributionId || !operation.stdout) {
      continue;
    }
    let data;
    try {
      data = JSON.parse(operation.stdout);
    } catch {
      continue;
    }
    const invalidationId = data?.Invalidation?.Id || "";
    if (!invalidationId) {
      continue;
    }
    const key = `${distributionId}:${invalidationId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({
      distributionId,
      invalidationId,
      surface: operation.surface || "",
    });
  }
  return targets;
}

export function defaultCloudFrontWaitRunner(args) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
  };
}

export function waitForCloudFrontInvalidations(
  result = {},
  { commandRunner = defaultCloudFrontWaitRunner } = {},
) {
  return cloudFrontInvalidationWaitTargets(result).map((target) => {
    const args = [
      "cloudfront",
      "wait",
      "invalidation-completed",
      "--distribution-id",
      target.distributionId,
      "--id",
      target.invalidationId,
    ];
    const outcome = commandRunner(args, target);
    if (outcome.status !== 0) {
      throw new Error(
        `cloudfront invalidation ${target.invalidationId} for ${target.distributionId} did not complete` +
          (outcome.stderr ? `: ${String(outcome.stderr).trim()}` : ""),
      );
    }
    return {
      ...target,
      status: "completed",
    };
  });
}
