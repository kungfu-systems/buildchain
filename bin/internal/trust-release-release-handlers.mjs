import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyInfraContractEvidenceBundle } from "../../scripts/infra-contract-core.mjs";
import { verifyBuildchainLogEvents } from "../../packages/core/logging.js";
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../../packages/core/release-line-dry-run.js";
import {
  planReleaseLineBootstrap,
  writeReleaseLineBootstrapVersionState,
} from "../../packages/core/release-line-bootstrap.js";
import {
  collectGitHubReleasePassport,
  explainReleasePassport,
  verifyReleasePassport,
} from "../../packages/core/release-passport.js";
import {
  createPublicationAdmission,
  createRunnerProvenance,
  verifyPublicationAdmission,
} from "../../packages/core/publication-authority.js";
import {
  createGitHubArtifactAttestationPolicy,
  createGitHubArtifactAttestationVerificationPlan,
  verifyGitHubArtifactAttestationEvidence,
} from "../../packages/core/github-artifact-attestation.js";
import {
  explainArtifactPassport,
  verifyArtifactPassport,
} from "../../packages/core/artifact-passport.js";
import {
  projectArtifactVerificationEnvelopeToKfx,
  verifyArtifactVerificationEnvelope,
} from "../../packages/core/artifact-verification-envelope.js";
import {
  artifactEnvelopeOptions,
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  writeJsonFile,
} from "./cli-options.mjs";

async function handleReleaseCommand({ args, runScript, packageVersion }) {
  if (args[0] === "line" && args[1] === "open") {
    const lineArgs = args.slice(2);
    const options = {
      cwd: readFlag(lineArgs, "cwd", process.cwd()),
      major: readFlag(lineArgs, "major", ""),
      minor: readFlag(lineArgs, "minor", ""),
      sourceRef: readFlag(lineArgs, "source-ref", ""),
      initialVersion: readFlag(lineArgs, "initial-version", ""),
    };
    const result = readBooleanFlag(lineArgs, "write")
      ? writeReleaseLineBootstrapVersionState({
          ...options,
          runVersionStateLifecycle: !readBooleanFlag(
            lineArgs,
            "skip-version-state-lifecycle",
          ),
          generatedAt: readFlag(lineArgs, "generated-at", ""),
        })
      : planReleaseLineBootstrap({
          ...options,
          requiredStatusCheck: readFlag(
            lineArgs,
            "required-status-check",
            "check",
          ),
          setDefault: !readBooleanFlag(lineArgs, "no-set-default"),
          createAlphaPr: !readBooleanFlag(lineArgs, "no-alpha-pr"),
          approvalCount: Number(readFlag(lineArgs, "approval-count", "1")),
          bootstrapBranch: readFlag(lineArgs, "bootstrap-branch", ""),
        });
    if (readBooleanFlag(lineArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(
        `Buildchain release line bootstrap ${result.line}\n`,
      );
      process.stdout.write(
        `- source: ${result.source.ref}${result.source.sha ? ` (${result.source.sha})` : ""}\n`,
      );
      process.stdout.write(`- initial version: ${result.initialVersion}\n`);
      process.stdout.write(`- dev: ${result.refs.dev}\n`);
      process.stdout.write(`- alpha: ${result.refs.alpha}\n`);
      process.stdout.write(`- release: ${result.refs.release}\n`);
      process.stdout.write(
        `- version files: ${result.versionState.files.join(", ") || "none"}\n`,
      );
      if (result.changedFiles) {
        process.stdout.write(
          `- changed files: ${result.changedFiles.join(", ") || "none"}\n`,
        );
      }
      process.stdout.write(
        result.dryRun
          ? "No refs, branches, PRs, or files were modified.\n"
          : "Version-state files were updated in the working tree.\n",
      );
    }
    return;
  }
  const explainMode = args[0] === "dry-run" || args[0] === "explain";
  const releaseArgs = explainMode ? args.slice(1) : args;
  if (explainMode || readBooleanFlag(args, "dry-run")) {
    const plan = explainReleaseLineDryRun({
      cwd: readFlag(releaseArgs, "cwd", process.cwd()),
      targetRef: readFlag(releaseArgs, "target-ref", ""),
      sourceRef: readFlag(releaseArgs, "source-ref", ""),
      sha: readFlag(releaseArgs, "sha", ""),
      tags: readFlag(releaseArgs, "tags", ""),
      publishTransaction: readBooleanFlag(releaseArgs, "publish-transaction"),
      publishCommand: readFlag(releaseArgs, "publish-command", ""),
    });
    if (readBooleanFlag(releaseArgs, "json")) {
      printJson(plan);
    } else {
      process.stdout.write(formatReleaseLineDryRun(plan));
    }
    return;
  }
  runScript("release-transaction.mjs", args);
  return;
}

async function handleTransactionCommand({ args, runScript, packageVersion }) {
  const [subcommand = "inspect", ...transactionArgs] = args;
  if (subcommand !== "inspect") {
    throw new Error("usage: buildchain transaction inspect ...");
  }
  runScript("release-transaction.mjs", ["inspect", ...transactionArgs]);
  return;
}

async function handleCreateCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", ...createArgs] = args;
  const inputValue = readFlag(createArgs, "input-json", "");
  if (
    !inputValue ||
    ![
      "publication-admission",
      "runner-provenance",
      "github-artifact-attestation-policy",
    ].includes(subcommand)
  ) {
    throw new Error(
      "usage: buildchain create <publication-admission|runner-provenance|github-artifact-attestation-policy> --input-json <file-or-json> [--output <file>]",
    );
  }
  const input = readJsonInput(inputValue, { label: "input-json" });
  const value =
    subcommand === "publication-admission"
      ? createPublicationAdmission(input)
      : subcommand === "runner-provenance"
        ? createRunnerProvenance(input)
        : createGitHubArtifactAttestationPolicy(input);
  const output = readFlag(createArgs, "output", "");
  if (output) writeJsonFile(path.resolve(output), value);
  if (!output || readBooleanFlag(createArgs, "json")) printJson(value);
  else process.stdout.write(`${subcommand}: ${output}\n`);
  return;
}

async function handleCollectCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", ...collectArgs] = args;
  if (subcommand !== "github-release") {
    throw new Error("usage: buildchain collect github-release --tag <tag>");
  }
  const workflow = {
    name: process.env.GITHUB_WORKFLOW || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    url:
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
    runnerKind: process.env.BUILDCHAIN_RUNNER_KIND || "github-hosted",
    runnerOs: process.env.RUNNER_OS || process.platform,
    runnerArch: process.env.RUNNER_ARCH || process.arch,
    runnerImage: process.env.ImageOS || "",
  };
  const result = collectGitHubReleasePassport({
    cwd: readFlag(collectArgs, "cwd", process.cwd()),
    tag: readFlag(collectArgs, "tag", ""),
    repository: readFlag(
      collectArgs,
      "repository",
      process.env.GITHUB_REPOSITORY || "",
    ),
    sourceSha: readFlag(
      collectArgs,
      "source-sha",
      process.env.GITHUB_SHA || "",
    ),
    line: readFlag(collectArgs, "line", ""),
    outputDir: readFlag(
      collectArgs,
      "output-dir",
      ".buildchain/release-passport",
    ),
    assetsDir: readFlag(collectArgs, "assets-dir", ""),
    assetsJson: readFlag(collectArgs, "assets-json", ""),
    releaseJson: readFlag(collectArgs, "release-json", ""),
    productName: readFlag(collectArgs, "product-name", "Buildchain"),
    packageName: readFlag(
      collectArgs,
      "package-name",
      "@kungfu-tech/buildchain",
    ),
    packageVersion: readFlag(collectArgs, "package-version", packageVersion()),
    packageSetJson: readFlag(collectArgs, "package-set-json", ""),
    publishEvidenceJson: readFlag(collectArgs, "publish-evidence-json", ""),
    trustedPublishingJson: readFlag(collectArgs, "trusted-publishing-json", ""),
    transactionJson: readFlag(collectArgs, "transaction-json", ""),
    anchorManifestJson: readFlag(collectArgs, "anchor-manifest-json", ""),
    impactJson: readFlag(collectArgs, "impact-json", ""),
    buildSummaryJson: readFlag(collectArgs, "build-summary-json", ""),
    buildFactsJsons: readRepeatedFlag(collectArgs, "build-facts-json"),
    platformManifestJsons: readRepeatedFlag(
      collectArgs,
      "platform-manifest-json",
    ),
    distTagEvidenceJson: readFlag(collectArgs, "dist-tag-evidence-json", ""),
    kfd1WitnessJsons: readRepeatedFlag(collectArgs, "kfd-1-witness-json"),
    kfd2ClaimJsons: readRepeatedFlag(collectArgs, "kfd-2-claim-json"),
    kfd3PrebuildWitnessJsons: readRepeatedFlag(
      collectArgs,
      "kfd-3-prebuild-witness-json",
    ),
    kfd3ArtifactWitnessJsons: readRepeatedFlag(
      collectArgs,
      "kfd-3-artifact-witness-json",
    ),
    kfd3ArtifactVerifyCommand: readFlag(
      collectArgs,
      "kfd-3-artifact-verify-cmd",
      "",
    ),
    kfdAdopterManifestJson: readFlag(
      collectArgs,
      "kfd-adopter-manifest-json",
      "",
    ),
    kfdSupportMatrixJson: readFlag(collectArgs, "kfd-support-matrix-json", ""),
    kfdProductGateJsons: readRepeatedFlag(collectArgs, "kfd-product-gate-json"),
    invariantPassportJsons: readRepeatedFlag(
      collectArgs,
      "invariant-passport-json",
    ),
    invariantPassportCommand: readFlag(
      collectArgs,
      "invariant-passport-cmd",
      "",
    ),
    releaseEvidenceJsons: readRepeatedFlag(
      collectArgs,
      "release-evidence-json",
    ),
    v4RuntimeResumeEvidenceJson: readFlag(
      collectArgs,
      "v4-runtime-resume-evidence-json",
      "",
    ),
    githubArtifactAttestationPolicyJsons: readRepeatedFlag(
      collectArgs,
      "github-artifact-attestation-policy-json",
    ),
    kfdAgentHubEvidenceJson: readFlag(
      collectArgs,
      "kfd-agent-hub-evidence-json",
      "",
    ),
    basePassportJson: readFlag(collectArgs, "base-passport-json", ""),
    requireBaseKfd: readBooleanFlag(collectArgs, "require-base-kfd"),
    releaseJsonExtra: readFlag(collectArgs, "release-extra-json", ""),
    publishJson: readFlag(collectArgs, "publish-json", ""),
    workflow,
  });
  if (readBooleanFlag(collectArgs, "json")) {
    printJson(result);
  } else {
    process.stdout.write(
      `release passport collected: ${path.relative(process.cwd(), result.outputDir)}\n`,
    );
    process.stdout.write(
      `artifacts: ${result.artifactEvidence.artifacts.length}\n`,
    );
  }
  return;
}

async function handleProjectCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", location = "", ...projectArgs] = args;
  if (subcommand !== "kfx-admission" || !location) {
    throw new Error("usage: buildchain project kfx-admission <file-or-json>");
  }
  const projection = projectArtifactVerificationEnvelopeToKfx({
    envelope: readJsonInput(location, {
      label: "artifact verification envelope",
    }),
    ...artifactEnvelopeOptions(projectArgs),
  });
  if (readBooleanFlag(projectArgs, "json")) {
    printJson(projection);
  } else {
    process.stdout.write(
      `KFX admission envelope: ${projection.envelopeRoot}\n`,
    );
  }
  return;
}

const RELEASE_COMMAND_HANDLERS = Object.freeze({
  release: handleReleaseCommand,
  transaction: handleTransactionCommand,
  create: handleCreateCommand,
  collect: handleCollectCommand,
  project: handleProjectCommand,
});

export { RELEASE_COMMAND_HANDLERS };
