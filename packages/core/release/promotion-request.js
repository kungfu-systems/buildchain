import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../runtime/installation-root.js";

const schemas = Object.fromEntries(
  ["request", "invocation"].map((kind) => [
    kind,
    JSON.parse(
      fs.readFileSync(
        path.join(
          installationRoot(import.meta.url),
          "contracts",
          `promotion-${kind}-v1.schema.json`,
        ),
        "utf8",
      ),
    ),
  ]),
);

export function normalizePromotionRequest(value, kind = "request") {
  const schema = schemas[kind];
  if (!schema) throw new Error(`Unknown promotion contract: ${kind}`);
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Promotion ${kind} must be an object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key))
      throw new Error(`Unsupported promotion ${kind} field: ${key}`);
  }
  const result = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    let input = Object.hasOwn(value, key) ? value[key] : property.default;
    if (input === undefined && schema.required.includes(key))
      throw new Error(`Promotion ${kind} requires ${key}`);
    if (input === undefined)
      input =
        property.type === "boolean"
          ? false
          : property.type === "number"
            ? 0
            : "";
    if (
      typeof input !== property.type ||
      (property.type === "number" && !Number.isFinite(input))
    )
      throw new Error(`Promotion ${kind} ${key} must be ${property.type}`);
    if (Object.hasOwn(property, "const") && input !== property.const)
      throw new Error(`Unsupported promotion ${kind} schema`);
    result[key] = input;
  }
  if (
    result["resume-discussion-id"] &&
    (result["resume-candidate-run-id"] || result["resume-transaction-id"])
  )
    throw new Error(
      "Discussion recovery cannot be combined with candidate-run or transaction-id recovery",
    );
  return result;
}

export function bindPromotionInvocation(requestValue, selection) {
  const request = normalizePromotionRequest(requestValue);
  const projected = Object.fromEntries(
    Object.entries(request).filter(([key]) =>
      Object.hasOwn(schemas.invocation.properties, key),
    ),
  );
  const routing = {
    "buildchain-expected-channel": "channel",
    channel: "publication-channel",
    "target-ref": "target-ref",
    "promotion-router-ref": "router-ref",
    "promotion-router-sha": "router-sha",
    "promotion-shell-ref": "shell-call-ref",
    "promotion-shell-sha": "shell-sha",
    "promotion-runtime-ref": "runtime-ref",
    "promotion-runtime-sha": "runtime-sha",
    "promotion-contract-lock-path": "contract-lock-path",
    "promotion-contract-lock-digest": "contract-lock-digest",
    "promotion-publication-channel": "publication-channel",
    "promotion-target-ref": "target-ref",
  };
  for (const [key, source] of Object.entries(routing)) {
    if (typeof selection[source] !== "string" || !selection[source])
      throw new Error(`Promotion selection requires ${source}`);
    projected[key] = selection[source];
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(selection["contract-lock-digest"]))
    throw new Error("Promotion contract lock must be rooted");
  if (!["true", "false"].includes(selection["override-used"]))
    throw new Error("Promotion override decision is missing");
  projected["promotion-override-used"] = selection["override-used"] === "true";
  projected["buildchain-expected-major"] = "4";
  projected["publication-authority-workflow-path"] =
    ".github/workflows/.release-promote.yml";
  projected.schema = "buildchain.promotion-invocation/v1";
  return normalizePromotionRequest(projected, "invocation");
}

export function verifyPromotionInvocation(value) {
  if (typeof value === "string") value = JSON.parse(value);
  const normalized = normalizePromotionRequest(value, "invocation");
  if (Object.keys(value).length !== Object.keys(normalized).length)
    throw new Error("Promotion invocation must include all normalized fields");
  if (
    !/^sha256:[0-9a-f]{64}$/.test(normalized["promotion-contract-lock-digest"])
  )
    throw new Error(
      "Promotion invocation requires its admitted contract lock root",
    );
  return normalized;
}
