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

async function handleAuditCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", ...auditArgs] = args;
  if (subcommand === "publication-control-plane") {
    runScript("audit-publication-control-plane.mjs", auditArgs);
    return;
  }
  if (subcommand === "github-governance") {
    runScript("audit-github-governance.mjs", auditArgs);
    return;
  }
  throw new Error(
    "usage: buildchain audit <publication-control-plane|github-governance> ...",
  );
}

async function handleExplainCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", ...explainArgs] = args;
  if (subcommand === "artifact") {
    const subject = explainArgs[0] || "";
    if (!subject) {
      throw new Error("usage: buildchain explain artifact <subject>");
    }
    const explanation = await explainArtifactPassport({
      subject,
      cwd: process.cwd(),
      passportLocation: readFlag(explainArgs, "passport", ""),
      locatorConfig: readFlag(explainArgs, "locator-config", ""),
      repository: readFlag(explainArgs, "repository", ""),
      tag: readFlag(explainArgs, "tag", ""),
      githubReleaseBaseUrl: readFlag(
        explainArgs,
        "github-release-base-url",
        "",
      ),
      subjectDigest: readFlag(explainArgs, "subject-digest", ""),
      subjectKind: readFlag(explainArgs, "subject-kind", ""),
      npmRegistryBaseUrl: readFlag(explainArgs, "npm-registry", ""),
      forAudience: readFlag(explainArgs, "for", "human"),
    });
    if (readBooleanFlag(explainArgs, "json")) {
      printJson(explanation);
    } else {
      process.stdout.write(
        `artifact: ${explanation.subject?.name || subject}\n`,
      );
      process.stdout.write(`trust: ${explanation.trust}\n`);
      process.stdout.write(`next action: ${explanation.nextAction}\n`);
    }
    process.exitCode = explanation.trust === "pass" ? 0 : 1;
    return;
  }
  if (subcommand !== "release") {
    throw new Error(
      "usage: buildchain explain release --passport <file-or-url>",
    );
  }
  const passport = readFlag(explainArgs, "passport", "");
  if (!passport) {
    throw new Error(
      "buildchain explain release requires --passport <file-or-url>",
    );
  }
  const explanation = await explainReleasePassport({
    passportLocation: passport,
    forAudience: readFlag(explainArgs, "for", "human"),
  });
  if (readBooleanFlag(explainArgs, "json")) {
    printJson(explanation);
  } else {
    process.stdout.write(`release: ${explanation.release?.tag || "unknown"}\n`);
    process.stdout.write(`trust: ${explanation.trust}\n`);
    process.stdout.write(`next action: ${explanation.nextAction}\n`);
  }
  return;
}

async function handleInspectCommand({ args, runScript, packageVersion }) {
  const [subcommand = "", ...inspectArgs] = args;
  if (subcommand === "artifact") {
    const subject = inspectArgs[0] || "";
    if (!subject) {
      throw new Error("usage: buildchain inspect artifact <subject>");
    }
    const report = await verifyArtifactPassport({
      subject,
      cwd: process.cwd(),
      passportLocation: readFlag(inspectArgs, "passport", ""),
      locatorConfig: readFlag(inspectArgs, "locator-config", ""),
      repository: readFlag(inspectArgs, "repository", ""),
      tag: readFlag(inspectArgs, "tag", ""),
      githubReleaseBaseUrl: readFlag(
        inspectArgs,
        "github-release-base-url",
        "",
      ),
      subjectDigest: readFlag(inspectArgs, "subject-digest", ""),
      subjectKind: readFlag(inspectArgs, "subject-kind", ""),
      npmRegistryBaseUrl: readFlag(inspectArgs, "npm-registry", ""),
    });
    printJson(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (subcommand !== "release") {
    throw new Error(
      "usage: buildchain inspect release --passport <file-or-url>",
    );
  }
  const passport = readFlag(inspectArgs, "passport", "");
  if (!passport) {
    throw new Error(
      "buildchain inspect release requires --passport <file-or-url>",
    );
  }
  const explanation = await explainReleasePassport({
    passportLocation: passport,
    forAudience: readFlag(inspectArgs, "for", "human"),
  });
  printJson(explanation);
  return;
}

const INSPECTION_COMMAND_HANDLERS = Object.freeze({
  audit: handleAuditCommand,
  explain: handleExplainCommand,
  inspect: handleInspectCommand,
});

export { INSPECTION_COMMAND_HANDLERS };
