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

async function verifyGitHubArtifactAttestationCommand({
  location,
  verifyArgs,
}) {
  if (!location) {
    throw new Error(
      "usage: buildchain verify github-artifact-attestation <artifact> --evidence <file> --bundle <file> --platform-manifest <file> --release-passport <file>",
    );
  }
  const requiredPath = (name) => {
    const value = readFlag(verifyArgs, name, "");
    if (!value) {
      throw new Error(
        `buildchain verify github-artifact-attestation requires --${name} <file>`,
      );
    }
    return path.resolve(value);
  };
  const evidencePath = requiredPath("evidence");
  const bundlePath = requiredPath("bundle");
  const platformManifestPath = requiredPath("platform-manifest");
  const releasePassportPath = requiredPath("release-passport");
  const evidence = readJsonInput(evidencePath, { label: "evidence" });
  const plan = createGitHubArtifactAttestationVerificationPlan({
    artifactPath: location,
    bundlePath,
    evidence,
  });
  const verified = spawnSync(plan.command, plan.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (verified.error) throw verified.error;
  if (verified.status !== 0) {
    throw new Error(
      `gh attestation verify failed: ${(verified.stderr || verified.stdout || "unknown error").trim()}`,
    );
  }
  let verificationResults;
  try {
    verificationResults = JSON.parse(verified.stdout);
  } catch (error) {
    throw new Error(
      `gh attestation verify returned invalid JSON: ${error.message}`,
    );
  }
  const report = verifyGitHubArtifactAttestationEvidence({
    artifactPath: path.resolve(location),
    platformManifestPath,
    releasePassportPath,
    bundlePath,
    evidence,
    verificationResults,
  });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`GitHub artifact attestation: ${report.outcome}\n`);
    for (const entry of report.issues) {
      process.stdout.write(`- ${entry.code}: ${entry.message}\n`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

async function verifyPublicationAdmissionCommand({ location, verifyArgs }) {
  if (!location) {
    throw new Error(
      "usage: buildchain verify publication-admission <file-or-json> --registry-json <file-or-json> --runner-json <file-or-json> --control-plane-audit-json <file-or-json> --publication-evidence-json <file-or-json>",
    );
  }
  const requiredInput = (name) => {
    const value = readFlag(verifyArgs, name, "");
    if (!value)
      throw new Error(
        `buildchain verify publication-admission requires --${name} <file-or-json>`,
      );
    return readJsonInput(value, { label: name });
  };
  const expectedInput = readFlag(verifyArgs, "expected-json", "");
  const capability = verifyPublicationAdmission({
    admission: readJsonInput(location, { label: "publication admission" }),
    registry: requiredInput("registry-json"),
    runnerProvenance: requiredInput("runner-json"),
    controlPlaneAudit: requiredInput("control-plane-audit-json"),
    publicationEvidence: requiredInput("publication-evidence-json"),
    expected: expectedInput
      ? readJsonInput(expectedInput, { label: "expected-json" })
      : {},
    usedNonces: readRepeatedFlag(verifyArgs, "used-nonce"),
  });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(capability);
  } else {
    process.stdout.write(`publication admission: ${capability.decision}\n`);
    process.stdout.write(`capability digest: ${capability.capabilityDigest}\n`);
    process.stdout.write(`expires at: ${capability.expiresAt}\n`);
  }
  return;
}

async function verifyArtifactCommand({ location, verifyArgs }) {
  if (!location) {
    throw new Error("usage: buildchain verify artifact <subject>");
  }
  const report = await verifyArtifactPassport({
    subject: location,
    cwd: process.cwd(),
    passportLocation: readFlag(verifyArgs, "passport", ""),
    locatorConfig: readFlag(verifyArgs, "locator-config", ""),
    repository: readFlag(verifyArgs, "repository", ""),
    tag: readFlag(verifyArgs, "tag", ""),
    githubReleaseBaseUrl: readFlag(verifyArgs, "github-release-base-url", ""),
    subjectDigest: readFlag(verifyArgs, "subject-digest", ""),
    subjectKind: readFlag(verifyArgs, "subject-kind", ""),
    npmRegistryBaseUrl: readFlag(verifyArgs, "npm-registry", ""),
  });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`artifact: ${report.outcome}\n`);
    process.stdout.write(`subject: ${report.subject?.name || location}\n`);
    process.stdout.write(
      `passport: ${report.passport?.location || report.discovery?.passportLocation || "unresolved"}\n`,
    );
    for (const entry of report.issues) {
      process.stdout.write(
        `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

async function verifyArtifactEnvelopeCommand({ location, verifyArgs }) {
  if (!location) {
    throw new Error(
      "usage: buildchain verify artifact-envelope <file-or-json>",
    );
  }
  const report = verifyArtifactVerificationEnvelope({
    envelope: readJsonInput(location, {
      label: "artifact verification envelope",
    }),
    ...artifactEnvelopeOptions(verifyArgs),
  });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`artifact verification envelope: ${report.outcome}\n`);
    process.stdout.write(`root: ${report.envelopeRoot || "unresolved"}\n`);
    for (const entry of report.issues) {
      process.stdout.write(
        `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

async function verifyObservabilityLogCommand({ location, verifyArgs }) {
  if (!location) {
    throw new Error("usage: buildchain verify observability-log <jsonl>");
  }
  const report = verifyBuildchainLogEvents({
    path: location,
    minEvents: Number(readFlag(verifyArgs, "min-events", "1")),
    allowErrors: readBooleanFlag(verifyArgs, "allow-errors"),
    requirePhases: readRepeatedFlag(verifyArgs, "require-phase"),
    requireComponents: readRepeatedFlag(verifyArgs, "require-component"),
    requireEvents: readRepeatedFlag(verifyArgs, "require-event"),
  });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`observability log: ${report.ok ? "ok" : "failed"}\n`);
    process.stdout.write(`events: ${report.summary.eventCount}\n`);
    for (const entry of report.issues) {
      process.stdout.write(
        `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

async function verifyInfraContractEvidenceBundleCommand({
  location,
  verifyArgs,
}) {
  if (!location) {
    throw new Error(
      "usage: buildchain verify infra-contract-evidence-bundle <file>",
    );
  }
  const bundle = JSON.parse(fs.readFileSync(path.resolve(location), "utf8"));
  const report = verifyInfraContractEvidenceBundle(bundle);
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(
      `infra contract evidence bundle: ${report.ok ? "ok" : "failed"}\n`,
    );
    process.stdout.write(`artifact: ${report.artifactHash || "unknown"}\n`);
    for (const entry of report.issues) {
      process.stdout.write(
        `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

async function verifyReleasePassportCommand({ location, verifyArgs }) {
  if (!location)
    throw new Error("usage: buildchain verify release-passport <file-or-url>");
  const report = await verifyReleasePassport({ passportLocation: location });
  if (readBooleanFlag(verifyArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`release passport: ${report.ok ? "ok" : "failed"}\n`);
    process.stdout.write(`artifacts: ${report.completeness.artifactCount}\n`);
    for (const entry of report.issues) {
      process.stdout.write(
        `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 1;
  return;
}

const VERIFY_COMMAND_HANDLERS = Object.freeze({
  "github-artifact-attestation": verifyGitHubArtifactAttestationCommand,
  "publication-admission": verifyPublicationAdmissionCommand,
  artifact: verifyArtifactCommand,
  "artifact-envelope": verifyArtifactEnvelopeCommand,
  "observability-log": verifyObservabilityLogCommand,
  "infra-contract-evidence-bundle": verifyInfraContractEvidenceBundleCommand,
  "release-passport": verifyReleasePassportCommand,
});

async function handleVerifyCommand({ args }) {
  const [subcommand = "", location = "", ...verifyArgs] = args;
  const handler = VERIFY_COMMAND_HANDLERS[subcommand];
  if (!handler) {
    throw new Error(
      "usage: buildchain verify <github-artifact-attestation|publication-admission|artifact|artifact-envelope|observability-log|infra-contract-evidence-bundle|release-passport> ...",
    );
  }
  return handler({ location, verifyArgs });
}

export { handleVerifyCommand };
