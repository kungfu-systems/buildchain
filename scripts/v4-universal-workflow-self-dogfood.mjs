#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  V4_UNIVERSAL_WORKFLOW_REQUEST,
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowAdmissionRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";

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

function defaultPolicy() {
  return JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-universal-workflow-train-admission.json",
        import.meta.url,
      ),
    ),
  );
}

function exactSha(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!SHA.test(normalized)) fail(`${label} must be an exact Git SHA`);
  return normalized;
}

export function createV4UniversalSelfDogfoodRequest({
  candidateSha,
  consumerSha,
  pullRequest,
  channel,
  policy = defaultPolicy(),
}) {
  const expectedSha = exactSha(candidateSha, "candidateSha");
  const sourceSha = exactSha(consumerSha, "consumerSha");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    fail("pullRequest must be a positive integer");
  if (!["alpha", "stable", "conformance"].includes(channel))
    fail("channel must be alpha, stable, or conformance");
  const capability =
    channel === "conformance"
      ? {
          id: "bootstrap-conformance",
          payload: {
            schema: "kungfu-buildchain-v4-universal-bootstrap-conformance/v1",
            expectedGovernedWorkflowCount: 40,
          },
        }
      : {
          id: "release-candidate-promote",
          payload: {
            schema: "kungfu-buildchain-v4-universal-release-promotion/v1",
            inputs: {
              channel,
              "dry-run": true,
              "target-ref":
                channel === "alpha" ? "alpha/v4/v4.0" : "release/v4/v4.0",
              "target-sha": sourceSha,
            },
            dryRunObservation: {
              observedSha: sourceSha,
              comparisonStatus: "identical",
            },
          },
        };
  return validateV4UniversalWorkflowRequest({
    schema: V4_UNIVERSAL_WORKFLOW_REQUEST,
    mode: "train",
    candidate: {
      repository: "kungfu-systems/buildchain",
      discoveryRef: "train/v4/v4.0/universal-reusable-workflow-bootstrap",
      expectedSha,
      admissionRoot: v4UniversalWorkflowAdmissionRoot(policy),
      reviewPullRequest: pullRequest,
    },
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
    value.runtime?.repository !== "kungfu-systems/buildchain" ||
    value.runtime?.sha !== expectedSha
  )
    fail(`${label} is not a successful exact-Train result`);
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

export function verifyV4UniversalSelfDogfoodPair({
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

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const command = process.argv[2];
  if (command === "request") {
    const request = createV4UniversalSelfDogfoodRequest({
      candidateSha: option("candidate-sha"),
      consumerSha: option("consumer-sha"),
      pullRequest: Number(option("pull-request")),
      channel: option("channel"),
    });
    process.stdout.write(`${JSON.stringify(request)}\n`);
    return;
  }
  if (command === "verify-pair") {
    const result = verifyV4UniversalSelfDogfoodPair({
      primary: JSON.parse(process.env.BUILDCHAIN_PRIMARY_RESULT_JSON || ""),
      recovery: JSON.parse(process.env.BUILDCHAIN_RECOVERY_RESULT_JSON || ""),
      expectedSha: option("candidate-sha"),
      channel: option("channel"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail("command must be request or verify-pair");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
