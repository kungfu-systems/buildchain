import fs from "node:fs";
import {
  HISTORICAL_PROMOTION_SCHEMA,
  historicalPromotionContext,
  historicalEvidenceFileKeys,
} from "./compatibility-context.js";
export { HISTORICAL_PROMOTION_SCHEMA } from "./compatibility-context.js";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { normalizePromotionRequest } from "../promotion-request.js";

const root = installationRoot(import.meta.url);
const read = (relative) =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
let historical, current;
function loadHistoricalContract() {
  historical ||= read(
    "contracts/fixtures/consumer-upgrade/release-v4.0.0.json",
  );
  current ||= read("contracts/promotion-request-v1.schema.json");
}
const transports = new Set([
  "request-json",
  "runtime-ref",
  "contract-lock",
  "runtime-selection",
]);
const selectors = new Set([
  "buildchain-channel",
  "buildchain-repository",
  "buildchain-ref",
  "buildchain-contract-lock-path",
  "buildchain-alpha-contract-lock-path",
  "buildchain-stable-contract-lock-path",
]);
export const HISTORICAL_PROMOTION_ENVELOPE =
  "buildchain.promotion-compatibility/v1";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function normalizeInputs(value) {
  const inputs = object(value, "Historical promotion inputs");
  for (const key of Object.keys(inputs)) {
    const field = historical.inputs[key];
    if (!field && !transports.has(key))
      throw new Error(`Unsupported historical promotion input: ${key}`);
    const type = field?.type || "string";
    if (
      typeof inputs[key] !== type ||
      (type === "number" && !Number.isFinite(inputs[key]))
    )
      throw new Error(`Historical promotion ${key} must be ${type}`);
  }
  return Object.fromEntries(
    Object.entries(historical.inputs).map(([key, field]) => [
      key,
      inputs[key] ??
        field.default ??
        (field.type === "boolean" ? false : field.type === "number" ? 0 : ""),
    ]),
  );
}

// The envelope is emitted only by the retained workflow. Ordinary request JSON
// remains the existing closed typed API; it cannot opt into a historical contract.
export function normalizeHistoricalPromotion(value, workflowRef) {
  const envelope = typeof value === "string" ? JSON.parse(value) : value;
  if (envelope?.schema !== HISTORICAL_PROMOTION_ENVELOPE)
    return { request: normalizePromotionRequest(value), historical: "" };
  loadHistoricalContract();
  object(envelope, "Historical promotion envelope");
  if (Object.keys(envelope).some((key) => !["schema", "inputs"].includes(key)))
    throw new Error("Unsupported historical promotion envelope field");
  if (
    workflowRef?.split("@")[0] !==
    "kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml"
  )
    throw new Error(
      "Historical promotion requires its retained workflow identity",
    );
  const inputs = normalizeInputs(envelope.inputs);
  const supplied = envelope.inputs["request-json"];
  if (supplied) {
    if (
      Object.entries(inputs).some(
        ([key, value]) =>
          value !== (historical.inputs[key].default ?? "") &&
          !selectors.has(key),
      )
    )
      throw new Error(
        "Cannot combine request-json with historical promotion arguments",
      );
    const typed = normalizePromotionRequest(supplied);
    return {
      request: typed,
      historical: JSON.stringify({
        schema: HISTORICAL_PROMOTION_SCHEMA,
        inputs: Object.fromEntries(
          historicalEvidenceFileKeys
            .filter((key) => typed[key])
            .map((key) => [key, typed[key]]),
        ),
      }),
    };
  }
  for (const key of [
    "branch-protection-bypass-users",
    "branch-protection-bypass-teams",
  ])
    if (inputs[key]) throw new Error(`Historical promotion rejects ${key}`);
  const request = { schema: "buildchain.promotion-request/v1" };
  const retained = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (Object.hasOwn(current.properties, key)) request[key] = value;
    else if (!selectors.has(key) && value !== "") retained[key] = value;
    if (historicalEvidenceFileKeys.includes(key) && value)
      retained[key] = value;
  }
  if (request["publish-mode"] === "publish-final-version") {
    retained["publish-mode"] = "publish-final-version";
    request["publish-mode"] = "";
  }
  if (request["publish-artifact-kind"] === "binary") {
    retained["publish-artifact-kind"] = "binary";
    request["publish-artifact-kind"] = "custom";
  }
  return {
    request: normalizePromotionRequest(request),
    historical: JSON.stringify(
      historicalPromotionContext({
        schema: HISTORICAL_PROMOTION_SCHEMA,
        inputs: retained,
      }),
    ),
  };
}
