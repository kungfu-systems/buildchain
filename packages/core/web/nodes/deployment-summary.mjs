import fs from "node:fs";
import { requireValue } from "../../runtime/action-process.mjs";
const read = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
export function deploymentSummary(channel) {
  requireValue(
    ["preview", "staging", "production", "cleanup"].includes(channel),
    "Unknown deployment summary channel",
  );
  const result = read(`.buildchain/web-surface-${channel}-apply.json`);
  if (channel === "cleanup")
    return `## Preview cleanup\n- status: ${result.status}\n- target: ${result.target}\n- aliases: ${result.entries.map((entry) => entry.alias).join(", ") || "none"}\n`;
  const health = read(`.buildchain/web-surface-${channel}-health.json`);
  const lines = Object.entries(result.urls || { default: result.url || "" })
    .filter(([, url]) => url)
    .map(([surface, url]) => `- ${surface}: ${url}`);
  if (channel === "production")
    lines.push(
      `- preflight: ${read(".buildchain/web-surface-production-preflight.json").status || "missing"}`,
    );
  lines.push(
    `- ${channel === "production" ? "deploy status" : "status"}: ${result.status || "missing"}`,
    `- health: ${health.status || "missing"}`,
    `- target: ${result.target || ""}`,
  );
  if (channel === "preview")
    lines.push(`- manifest: ${result.manifestKey || ""}`);
  else
    lines.push(
      `- source: ${result.sourceSha || ""}`,
      `- artifact: ${result.artifactHash || ""}`,
    );
  if (channel === "production")
    lines.push(
      `- rollback pointer: ${result.manifest?.rollbackPointer || "not configured"}`,
    );
  return [
    `## ${channel[0].toUpperCase() + channel.slice(1)} apply`,
    ...lines,
    "",
  ].join("\n");
}
export function summarizeDeployment(env) {
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    deploymentSummary(env.BUILDCHAIN_WEB_CHANNEL),
  );
}
