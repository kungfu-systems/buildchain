#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createReleaseCandidatePassport, validateReleaseCandidatePassport } from "../packages/core/release-candidate.js";
import { scanV4FloatingConsumerPolicy, v4ConsumerPolicyScannerRoot } from "../packages/core/v4-floating-consumer-policy.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { V4_STAGE_CAPSULE_CONTRACT, V4_STAGE_CAPSULE_IDENTITY_CONTRACT, v4StageCapsuleIdentityRoot, v4StageCapsuleRoot, validateV4StageCapsule } from "../packages/core/v4-stage-capsule.js";
import { v4RuntimeResumeDocumentRoot } from "../packages/core/v4-runtime-ref-resume-authority.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const env = (name, fallback = "") => process.env[name] || fallback;
const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

export function createReleaseCandidateStageCapsules({
  passport,
  buildSummary,
  coordinates,
}) {
  if (!passport.consumerPolicy?.receiptRoot) return undefined;
  if (
    coordinates.repository !== passport.repository ||
    String(coordinates.runId) !== String(passport.workflow.runId) ||
    String(coordinates.runAttempt) !== String(passport.workflow.runAttempt) ||
    coordinates.sourceSha !== passport.source.headSha
  ) {
    throw new Error(
      "Stage Capsule coordinate set does not bind the candidate run",
    );
  }
  const coordinateByPlatform = new Map(
    coordinates.artifacts.map((entry) => [entry.platformId, entry]),
  );
  const qualificationRoot = passport.controllerReceipts?.[0]?.receiptDigest;
  const entries = passport.platformMatrix
    .map((platform) => {
      const coordinate = coordinateByPlatform.get(platform.platformId);
      if (!coordinate || coordinate.name !== platform.artifactName) {
        throw new Error(
          `Stage Capsule coordinate missing for ${platform.platformId}`,
        );
      }
      const manifest = readJsonFile(platform.manifestPath);
      const identity = {
        schema: V4_STAGE_CAPSULE_IDENTITY_CONTRACT,
        sourceRoot: v4ContentRoot("candidate-identity", passport.source),
        platform: platform.platformId,
        platformRoot: v4ContentRoot("candidate-identity", manifest.platform),
        stage: "verify",
        toolchainRoots: [],
        runtimeRoot: v4ContentRoot("candidate-identity", {
          sha: passport.buildchain.sha,
        }),
        policyRoot: passport.consumerPolicy.receiptRoot,
        declaredInputs: [
          {
            name: "release-candidate",
            root: `sha256:${passport.candidateHash}`,
          },
        ],
        transformationRoot: v4ContentRoot("candidate-identity", {
          lifecycle: manifest.lifecycle,
          summary: platform.summary,
        }),
        outputManifestRoot: v4ContentRoot(
          "stage-capsule-artifact-manifest",
          { artifact: coordinate, manifest },
        ),
        qualificationRoot,
        observationRoots: [
          {
            name: "provider-coordinate",
            root: v4ContentRoot("provider-readback-sample", coordinate),
          },
        ],
      };
      const capsule = {
        schema: V4_STAGE_CAPSULE_CONTRACT,
        writerAuthority: "typescript-v3",
        rustAuthority: "validation-only",
        identity,
        identityRoot: v4StageCapsuleIdentityRoot(identity),
        retentionPromise: {
          class: "github-artifact",
          retainUntil: coordinate.expiresAt,
        },
        capsuleRoot: `sha256:${"0".repeat(64)}`,
      };
      capsule.capsuleRoot = v4StageCapsuleRoot(capsule);
      validateV4StageCapsule(capsule);
      return {
        platform: platform.platformId,
        artifactName: coordinate.name,
        artifactDigest: coordinate.digest,
        artifact: coordinate,
        capsule,
      };
    })
    .sort((left, right) => left.platform.localeCompare(right.platform));
  const body = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-release-candidate-stage-capsules/v1",
    status: "sealed",
    repository: passport.repository,
    buildAttempt: {
      id: `github-run:${passport.workflow.runId}:attempt:${passport.workflow.runAttempt}`,
      runtimeSha: passport.buildchain.sha,
    },
    source: {
      sha: passport.source.headSha,
      treeSha: passport.source.treeHash,
    },
    consumerPolicyReceiptRoot: passport.consumerPolicy.receiptRoot,
    capsules: entries,
  };
  return { ...body, root: v4RuntimeResumeDocumentRoot(body) };
}

function writeReleaseCandidateStageCapsules({
  passport,
  buildSummary,
  outputPath,
}) {
  const coordinatesPath = path.resolve(
    env(
      "BUILDCHAIN_ARTIFACT_COORDINATES_PATH",
      ".buildchain/artifacts/artifact-coordinates.json",
    ),
  );
  if (!fs.existsSync(coordinatesPath)) {
    if (passport.consumerPolicy?.receiptRoot) {
      throw new Error(
        "v4 release candidate Stage Capsules require exact artifact coordinates",
      );
    }
    return { path: "", root: "" };
  }
  const stageCapsules = createReleaseCandidateStageCapsules({
    passport,
    buildSummary,
    coordinates: readJsonFile(coordinatesPath),
  });
  if (!stageCapsules) return { path: "", root: "" };
  const stageCapsulesPath = path.join(
    path.dirname(outputPath),
    "release-candidate-stage-capsules.json",
  );
  fs.writeFileSync(
    stageCapsulesPath,
    `${JSON.stringify(stageCapsules, null, 2)}\n`,
  );
  return {
    path: path
      .relative(process.cwd(), stageCapsulesPath)
      .split(path.sep)
      .join("/"),
    root: stageCapsules.root,
  };
}

export function resolveLegacyConsumerPolicyReceipt(options = {}) {
  if (options.json) return { receipt: JSON.parse(options.json), receiptRoot: options.receiptRoot };
  if (options.repository !== "kungfu-systems/buildchain" || options.targetChannel !== "alpha" || options.workflowShellRef !== "v4-alpha" || options.runtimeOverride !== true) return undefined;
  if (!/^[0-9a-f]{40}$/u.test(options.runtimeRef || "") || options.runtimeRef !== options.runtimeSha || options.sourceTreeHash !== options.runtimeTreeHash()) return undefined;
  const root = path.resolve(options.root || ".buildchain/runtime");
  const alphaLock = readJsonFile(path.join(root, ".buildchain/alpha-contract-lock.json"));
  const result = scanV4FloatingConsumerPolicy({
    root, repository: options.repository, sourceSha: options.sourceSha,
    invokedWorkflow: options.invokedWorkflow || ".github/workflows/build.yml", invocationSourcePath: options.invocationSourcePath,
    expectedInvocationChannel: "alpha", resolvedWorkflowSha: alphaLock.buildchain?.resolvedSha,
    resolvedRuntimeSha: options.runtimeSha, scannerRoot: v4ConsumerPolicyScannerRoot(),
    policy: readJsonFile(path.resolve(import.meta.dirname, "../architecture/v4-floating-consumer-policy.json")),
  });
  if (!result.ok) throw new Error(`legacy floating-shell policy receipt invalid: ${result.failures.map(({ code }) => code).join(", ")}`);
  return { receipt: result.receipt, receiptRoot: result.receiptRoot };
}

export function generateReleaseCandidatePassportCli() {
  const buildSummaryPath = path.resolve(env("BUILDCHAIN_BUILD_SUMMARY_PATH", ".buildchain/artifacts/build-summary.json"));
  const outputPath = path.resolve(env("BUILDCHAIN_RC_PASSPORT_PATH", ".buildchain/artifacts/release-candidate-passport.json"));
  const buildSummary = readJsonFile(buildSummaryPath);
  const sourceSha = env("BUILDCHAIN_RC_SOURCE_HEAD_SHA", buildSummary.publishSource?.sha || buildSummary.git?.sha || "");
  const version = env("BUILDCHAIN_RC_VERSION", buildSummary.publishSource?.consumerVersion || "");
  const gateAggregateJson = env("BUILDCHAIN_GATE_PROFILE_AGGREGATE_JSON");
  const gateAggregate = gateAggregateJson ? JSON.parse(gateAggregateJson) : undefined;
  const controllerReceiptJson = env("BUILDCHAIN_CONTROLLER_RECEIPT_JSON");
  const controllerReceipts = controllerReceiptJson ? [JSON.parse(controllerReceiptJson)] : [];
  const familyEvidenceJson = env("BUILDCHAIN_RC_FAMILY_EVIDENCE_JSON");
  const familyEvidence = familyEvidenceJson ? JSON.parse(familyEvidenceJson) : undefined;
  const consumerPolicyJson = env("BUILDCHAIN_V4_POLICY_RECEIPT_JSON");
  const consumerPolicyReceipt = resolveLegacyConsumerPolicyReceipt({
    json: consumerPolicyJson, receiptRoot: env("BUILDCHAIN_V4_POLICY_RECEIPT_ROOT"),
    repository: env("GITHUB_REPOSITORY", buildSummary.git?.repository || ""), sourceSha,
    targetChannel: env("BUILDCHAIN_RC_TARGET_CHANNEL", buildSummary.publishSource?.channel || buildSummary.publishGate?.channel || ""),
    runtimeRef: env("BUILDCHAIN_RUNTIME_REF", buildSummary.runtime?.ref || ""), runtimeSha: env("BUILDCHAIN_RUNTIME_SHA", buildSummary.runtime?.sha || ""),
    workflowShellRef: env("BUILDCHAIN_WORKFLOW_SHELL_REF", buildSummary.runtime?.workflowShellRef || ""), runtimeOverride: buildSummary.runtime?.override === true,
    root: ".buildchain/runtime", invocationSourcePath: env("GITHUB_WORKFLOW_REF"), sourceTreeHash: env("BUILDCHAIN_RC_SOURCE_TREE_HASH"),
    runtimeTreeHash: () => execFileSync("git", ["-C", ".buildchain/runtime", "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  });
  const passport = createReleaseCandidatePassport({
    repository: env("GITHUB_REPOSITORY", buildSummary.git?.repository || ""),
    pullRequest: {
      number: env("BUILDCHAIN_PULL_REQUEST_NUMBER"), url: env("BUILDCHAIN_PULL_REQUEST_URL"),
      headRef: env("BUILDCHAIN_PULL_REQUEST_HEAD_REF"), baseRef: env("BUILDCHAIN_PULL_REQUEST_BASE_REF"),
    },
    targetChannel: env("BUILDCHAIN_RC_TARGET_CHANNEL", buildSummary.publishSource?.channel || buildSummary.publishGate?.channel || ""),
    version,
    sourceHeadSha: sourceSha,
    baseSha: env("BUILDCHAIN_RC_BASE_SHA"),
    mergeRefSha: env("BUILDCHAIN_RC_MERGE_REF_SHA", buildSummary.git?.sha || ""),
    sourceTreeHash: env("BUILDCHAIN_RC_SOURCE_TREE_HASH"),
    buildSummary,
    buildchain: {
      ref: env("BUILDCHAIN_RUNTIME_REF", buildSummary.runtime?.ref || ""), sha: env("BUILDCHAIN_RUNTIME_SHA", buildSummary.runtime?.sha || ""),
      version: env("BUILDCHAIN_RUNTIME_VERSION"), workflowShellRef: env("BUILDCHAIN_WORKFLOW_SHELL_REF", buildSummary.runtime?.workflowShellRef || ""),
    },
    gateAggregate,
    familyEvidence,
    consumerPolicyReceipt,
    controllerReceipts,
    workflow: {
      name: env("GITHUB_WORKFLOW"), runId: env("GITHUB_RUN_ID", buildSummary.git?.runId || ""),
      runAttempt: env("GITHUB_RUN_ATTEMPT", buildSummary.git?.runAttempt || ""), url: env("BUILDCHAIN_WORKFLOW_RUN_URL"),
    },
  });
  const validation = validateReleaseCandidatePassport({
    passport, repository: env("GITHUB_REPOSITORY", buildSummary.git?.repository || ""), sourceHeadSha: sourceSha, buildSummary });
  if (!validation.ok) throw new Error(`release candidate passport invalid: ${validation.errors.join("; ")}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(passport, null, 2)}\n`);
  const stageCapsules = writeReleaseCandidateStageCapsules({ passport, buildSummary, outputPath });
  writeGitHubOutputs({
    "release-candidate-passport-path": path.relative(process.cwd(), outputPath).split(path.sep).join("/"),
    "release-candidate-passport-json": JSON.stringify({
      contract: passport.contract,
      repository: passport.repository,
      target: passport.target,
      source: passport.source,
      candidateHash: passport.candidateHash,
      platformCount: passport.platformMatrix.length,
      gateProfileEvidence: passport.gateProfileEvidence,
      familyEvidence: passport.familyEvidence,
      consumerPolicy: passport.consumerPolicy,
      controllerReceipts: passport.controllerReceipts || [],
    }),
    "release-candidate-stage-capsules-path": stageCapsules.path,
    "release-candidate-stage-capsules-root": stageCapsules.root,
  });
  return passport;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    generateReleaseCandidatePassportCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
