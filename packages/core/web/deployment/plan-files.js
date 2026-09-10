import fs from "node:fs";
import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
export function exactWebPlan(directory, filename) {
  const matches = fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === filename)
    .map((entry) => path.join(entry.parentPath, entry.name));
  requireValue(
    matches.length === 1,
    `Expected exactly one ${filename}, found ${matches.length}`,
  );
  return matches[0];
}
export function selectWebOutputs(workspace = process.cwd()) {
  const plans = ["preview", "staging", "production", "cleanup"]
    .map((channel) => ({
      channel,
      file: path.join(
        workspace,
        `.buildchain/web-surface-${channel}-plan.json`,
      ),
    }))
    .filter(({ file }) => fs.existsSync(file));
  requireValue(
    plans.length <= 1,
    "Multiple Web channel plans cannot select one result",
  );
  if (!plans.length) return {};
  const { channel, file } = plans[0];
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (channel === "cleanup")
    return { "web-surface-cleanup-plan-json": JSON.stringify(plan) };
  return {
    "web-surface-channel": plan.channel || "",
    "web-surface-alias": plan.alias || "",
    "web-surface-url": plan.url || "",
    "web-surface-urls-json": JSON.stringify(plan.urls || {}),
    "web-surface-manifest-json": JSON.stringify(plan.manifest || {}),
  };
}
