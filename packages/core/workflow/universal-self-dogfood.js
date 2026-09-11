import path from "node:path";
import { installationRoot } from "../runtime/installation-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  UNIVERSAL_WORKFLOW_REQUEST,
  validateUniversalWorkflowRequest,
  universalWorkflowAdmissionRoot,
} from "./universal-workflow-bootstrap.js";

const SHA = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function contentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(canonical(value))}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function defaultPolicy() { return JSON.parse(fs.readFileSync(path.join(installationRoot(import.meta.url), "architecture/universal-workflow-capability-policy.json"), "utf8")); }

function exactSha(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!SHA.test(normalized)) fail(`${label} must be an exact Git SHA`);
  return normalized;
}

export function createUniversalSelfDogfoodRequest({
  consumerSha,
  channel,
  policy = defaultPolicy(),
}) {
  const sourceSha = exactSha(consumerSha, "consumerSha");
  if (!["alpha", "stable", "conformance"].includes(channel))
    fail("channel must be alpha, stable, or conformance");
  const capability =
    channel === "conformance"
      ? {
          id: "bootstrap-conformance",
          payload: {
            schema: "kungfu-buildchain-v4-universal-bootstrap-conformance/v1",
            expectedGovernedWorkflowCount: JSON.parse(fs.readFileSync(path.join(
              installationRoot(import.meta.url), "architecture/universal-workflow-bootstrap.json",
            ), "utf8")).bootstrapGovernedWorkflows.length,
          },
        }
      : {
          id: "release-candidate-promote",
          payload: {
            schema: "kungfu-buildchain-v4-universal-release-promotion/v1",
            inputs: {
              schema: "buildchain.promotion-request/v1",
              channel,
              "dry-run": true,
              "target-ref":
                channel === "alpha" ? "alpha/v4/v4.1" : "release/v4/v4.1",
              "target-sha": sourceSha,
            },
            dryRunObservation: {
              observedSha: sourceSha,
              comparisonStatus: "identical",
            },
          },
        };
  return validateUniversalWorkflowRequest({
    schema: UNIVERSAL_WORKFLOW_REQUEST,
    consumer: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/self-ops-bootstrap-dogfood.yml",
      sourceSha,
    },
    capability: {
      id: capability.id,
      contractRoots: policy.contractRoots,
      permissions: { contents: "read" },
    },
    payload: capability.payload,
  });
}

function exactResult(value, label, expectedSha, expectedChannel) {
  if (
    value?.schema !== "kungfu-buildchain-v4-universal-workflow-result/v1" ||
    value.status !== "succeeded" ||
    value.runtime?.repository !== "kungfu-systems/buildchain"
  )
    fail(`${label} is not a successful exact-candidate result`);
  if (expectedChannel === "conformance") {
    if (
      value.output?.schema !==
        "kungfu-buildchain-v4-universal-bootstrap-conformance-result/v1" ||
      value.output?.status !== "candidate-engine-executed"
    )
      fail(`${label} did not execute the candidate conformance engine`);
  } else if (
    value.output?.dryRun !== true ||
    value.output?.route?.decision !== "Fresh" ||
    value.output?.route?.channel !== expectedChannel
  ) {
    fail(
      `${label} did not execute the ${expectedChannel}-shaped release route`,
    );
  }
  return value;
}

export function verifyUniversalSelfDogfoodPair({
  primary,
  recovery,
  expectedSha,
  channel,
}) {
  const sha = exactSha(expectedSha, "expectedSha");
  const left = exactResult(primary, "primary result", sha, channel);
  const right = exactResult(recovery, "recovery result", sha, channel);
  for (const field of ["requestRoot", "capabilityRoot", "resultRoot"]) {
    if (left[field] !== right[field])
      fail(`primary and recovery ${field} differ`);
  }
  const body = {
    schema: "kungfu-buildchain-v4-universal-self-dogfood-pair/v1",
    channel,
    runtimeSha: sha,
    requestRoot: left.requestRoot,
    capabilityRoot: left.capabilityRoot,
    resultRoot: left.resultRoot,
    equivalent: true,
  };
  return {
    ...body,
    pairRoot: contentRoot("universal-self-dogfood-pair", body),
  };
}
