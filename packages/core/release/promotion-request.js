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
  return result;
}

export function bindPromotionInvocation(
  requestValue,
  selection,
  authorization = {},
) {
  const request = normalizePromotionRequest(requestValue);
  const projected = Object.fromEntries(
    Object.entries(request).filter(([key]) =>
      Object.hasOwn(schemas.invocation.properties, key),
    ),
  );
  const routing = {
    "buildchain-ref": "runtime-sha",
    "buildchain-contract-lock-path": "contract-lock-path",
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
  for (const key of ["runtime-sha", "shell-sha", "router-sha"])
    if (!/^[0-9a-f]{40}$/.test(selection[key]))
      throw new Error(`Promotion selection ${key} must be exact`);
  if (
    selection["router-sha"] !== selection["shell-sha"] ||
    selection["shell-call-ref"] !== selection["shell-sha"]
  )
    throw new Error("Publisher must use the exact defining workflow");
  if (!/^sha256:[0-9a-f]{64}$/.test(selection["contract-lock-digest"]))
    throw new Error("Promotion contract lock must be rooted");
  if (!["true", "false"].includes(selection["override-used"]))
    throw new Error("Promotion override decision is missing");
  projected["promotion-override-used"] = selection["override-used"] === "true";
  projected["promotion-runtime-authorization-json"] =
    authorization["runtime-authorization-json"] || "";
  projected["promotion-runtime-authorization-root"] =
    authorization["runtime-authorization-root"] || "";
  if (
    projected["promotion-override-used"] &&
    (!projected["promotion-runtime-authorization-json"] ||
      !/^sha256:[0-9a-f]{64}$/.test(
        projected["promotion-runtime-authorization-root"],
      ))
  )
    throw new Error(
      "Promotion override requires rooted consumer authorization",
    );
  projected["buildchain-expected-major"] = "4";
  projected["publication-authority-workflow-path"] =
    ".github/workflows/.release-promote.yml";
  projected.schema = "buildchain.promotion-invocation/v1";
  return normalizePromotionRequest(projected, "invocation");
}

export function verifyPromotionInvocation(value, workflowSha) {
  if (typeof value === "string") value = JSON.parse(value);
  const normalized = normalizePromotionRequest(value, "invocation");
  if (Object.keys(value).length !== Object.keys(normalized).length)
    throw new Error("Promotion invocation must include all normalized fields");
  if (
    !/^[0-9a-f]{40}$/.test(workflowSha || "") ||
    normalized["promotion-shell-sha"] !== workflowSha ||
    normalized["promotion-router-sha"] !== workflowSha ||
    normalized["promotion-shell-ref"] !== workflowSha
  )
    throw new Error(
      "Promotion invocation is not bound to this defining workflow",
    );
  if (
    !/^[0-9a-f]{40}$/.test(normalized["promotion-runtime-sha"]) ||
    normalized["buildchain-ref"] !== normalized["promotion-runtime-sha"]
  )
    throw new Error("Promotion runtime must bind one exact admitted commit");
  if (
    !/^sha256:[0-9a-f]{64}$/.test(normalized["promotion-contract-lock-digest"])
  )
    throw new Error(
      "Promotion invocation requires its admitted contract lock root",
    );
  return normalized;
}
