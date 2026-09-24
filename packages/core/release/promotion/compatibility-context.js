import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";

export const HISTORICAL_PROMOTION_SCHEMA = "buildchain.historical-promotion/v1";
export const HISTORICAL_PUBLISHER = ".github/workflows/.release-historical.yml";
let fields, current;
function loadHistoricalFields() {
  if (fields) return;
  const root = installationRoot(import.meta.url);
  fields = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "contracts/fixtures/consumer-upgrade/release-v4.0.0.json",
      ),
      "utf8",
    ),
  ).inputs;
  current = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/promotion-request-v1.schema.json"),
      "utf8",
    ),
  ).properties;
}
export const historicalEvidenceFileKeys = [
  "release-passport-kfd-1-witness-jsons",
  "release-passport-kfd-2-claim-jsons",
  "release-passport-kfd-3-prebuild-witness-jsons",
  "release-passport-kfd-3-artifact-witness-jsons",
  "release-passport-impact-json",
];
const excluded = new Set([
  "buildchain-channel",
  "buildchain-repository",
  "buildchain-ref",
  "buildchain-contract-lock-path",
  "buildchain-alpha-contract-lock-path",
  "buildchain-stable-contract-lock-path",
  "branch-protection-bypass-users",
  "branch-protection-bypass-teams",
]);

export function historicalPromotionContext(value) {
  if (!value) return null;
  loadHistoricalFields();
  const context = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !context ||
    context.schema !== HISTORICAL_PROMOTION_SCHEMA ||
    Object.keys(context).some((key) => !["schema", "inputs"].includes(key)) ||
    !context.inputs ||
    typeof context.inputs !== "object" ||
    Array.isArray(context.inputs)
  )
    throw new Error("Invalid historical promotion context");
  for (const [key, value] of Object.entries(context.inputs)) {
    const field = fields[key];
    if (
      !field ||
      excluded.has(key) ||
      (current[key] &&
        ![
          "publish-artifact-kind",
          "publish-mode",
          ...historicalEvidenceFileKeys,
        ].includes(key)) ||
      typeof value !== field.type ||
      (field.type === "number" && !Number.isFinite(value))
    )
      throw new Error(`Unsupported historical promotion context field: ${key}`);
    if (
      /^resume-.*runtime-sha$/u.test(key) &&
      value &&
      !/^[a-f0-9]{40}$/u.test(value)
    )
      throw new Error(`Historical ${key} requires an exact runtime SHA`);
    if (key === "publish-mode" && value !== "publish-final-version")
      throw new Error(
        "Historical publish-mode translation requires publish-final-version",
      );
    if (key === "publish-artifact-kind" && value !== "binary")
      throw new Error("Historical artifact-kind translation requires binary");
  }
  return context;
}

export function historicalPublisherPath(value) {
  return historicalPromotionContext(value)
    ? HISTORICAL_PUBLISHER
    : ".github/workflows/.release-promote.yml";
}
