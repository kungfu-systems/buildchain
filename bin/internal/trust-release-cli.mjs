import fs from "node:fs";
import path from "node:path";
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

const TRUST_RELEASE_COMMANDS = new Set([
  "audit",
  "collect",
  "create",
  "explain",
  "inspect",
  "project",
  "release",
  "transaction",
  "verify",
]);

async function dispatchTrustReleaseCommand({ command, args, runScript, packageVersion }) {
  if (command === "release") {
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
            runVersionStateLifecycle: !readBooleanFlag(lineArgs, "skip-version-state-lifecycle"),
            generatedAt: readFlag(lineArgs, "generated-at", ""),
          })
        : planReleaseLineBootstrap({
            ...options,
            requiredStatusCheck: readFlag(lineArgs, "required-status-check", "check"),
            setDefault: !readBooleanFlag(lineArgs, "no-set-default"),
            createAlphaPr: !readBooleanFlag(lineArgs, "no-alpha-pr"),
            approvalCount: Number(readFlag(lineArgs, "approval-count", "1")),
            bootstrapBranch: readFlag(lineArgs, "bootstrap-branch", ""),
          });
      if (readBooleanFlag(lineArgs, "json")) {
        printJson(result);
      } else {
        process.stdout.write(`Buildchain release line bootstrap ${result.line}\n`);
        process.stdout.write(`- source: ${result.source.ref}${result.source.sha ? ` (${result.source.sha})` : ""}\n`);
        process.stdout.write(`- initial version: ${result.initialVersion}\n`);
        process.stdout.write(`- dev: ${result.refs.dev}\n`);
        process.stdout.write(`- alpha: ${result.refs.alpha}\n`);
        process.stdout.write(`- release: ${result.refs.release}\n`);
        process.stdout.write(`- version files: ${result.versionState.files.join(", ") || "none"}\n`);
        if (result.changedFiles) {
          process.stdout.write(`- changed files: ${result.changedFiles.join(", ") || "none"}\n`);
        }
        process.stdout.write(result.dryRun ? "No refs, branches, PRs, or files were modified.\n" : "Version-state files were updated in the working tree.\n");
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

  if (command === "transaction") {
    const [subcommand = "inspect", ...transactionArgs] = args;
    if (subcommand !== "inspect") {
      throw new Error("usage: buildchain transaction inspect ...");
    }
    runScript("release-transaction.mjs", ["inspect", ...transactionArgs]);
    return;
  }

  if (command === "create") {
    const [subcommand = "", ...createArgs] = args;
    const inputValue = readFlag(createArgs, "input-json", "");
    if (!inputValue || !["publication-admission", "runner-provenance"].includes(subcommand)) {
      throw new Error("usage: buildchain create <publication-admission|runner-provenance> --input-json <file-or-json> [--output <file>]");
    }
    const input = readJsonInput(inputValue, { label: "input-json" });
    const value = subcommand === "publication-admission"
      ? createPublicationAdmission(input)
      : createRunnerProvenance(input);
    const output = readFlag(createArgs, "output", "");
    if (output) writeJsonFile(path.resolve(output), value);
    if (!output || readBooleanFlag(createArgs, "json")) printJson(value);
    else process.stdout.write(`${subcommand}: ${output}\n`);
    return;
  }

  if (command === "collect") {
    const [subcommand = "", ...collectArgs] = args;
    if (subcommand !== "github-release") {
      throw new Error("usage: buildchain collect github-release --tag <tag>");
    }
    const workflow = {
      name: process.env.GITHUB_WORKFLOW || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
      url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
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
      repository: readFlag(collectArgs, "repository", process.env.GITHUB_REPOSITORY || ""),
      sourceSha: readFlag(collectArgs, "source-sha", process.env.GITHUB_SHA || ""),
      line: readFlag(collectArgs, "line", ""),
      outputDir: readFlag(collectArgs, "output-dir", ".buildchain/release-passport"),
      assetsDir: readFlag(collectArgs, "assets-dir", ""),
      assetsJson: readFlag(collectArgs, "assets-json", ""),
      releaseJson: readFlag(collectArgs, "release-json", ""),
      productName: readFlag(collectArgs, "product-name", "Buildchain"),
      packageName: readFlag(collectArgs, "package-name", "@kungfu-tech/buildchain"),
      packageVersion: readFlag(collectArgs, "package-version", packageVersion()),
      packageSetJson: readFlag(collectArgs, "package-set-json", ""),
      publishEvidenceJson: readFlag(collectArgs, "publish-evidence-json", ""),
      trustedPublishingJson: readFlag(collectArgs, "trusted-publishing-json", ""),
      transactionJson: readFlag(collectArgs, "transaction-json", ""),
      anchorManifestJson: readFlag(collectArgs, "anchor-manifest-json", ""),
      impactJson: readFlag(collectArgs, "impact-json", ""),
      buildSummaryJson: readFlag(collectArgs, "build-summary-json", ""),
      buildFactsJsons: readRepeatedFlag(collectArgs, "build-facts-json"),
      platformManifestJsons: readRepeatedFlag(collectArgs, "platform-manifest-json"),
      distTagEvidenceJson: readFlag(collectArgs, "dist-tag-evidence-json", ""),
      kfd1WitnessJsons: readRepeatedFlag(collectArgs, "kfd-1-witness-json"),
      kfd2ClaimJsons: readRepeatedFlag(collectArgs, "kfd-2-claim-json"),
      kfd3PrebuildWitnessJsons: readRepeatedFlag(collectArgs, "kfd-3-prebuild-witness-json"),
      kfd3ArtifactWitnessJsons: readRepeatedFlag(collectArgs, "kfd-3-artifact-witness-json"),
      kfd3ArtifactVerifyCommand: readFlag(collectArgs, "kfd-3-artifact-verify-cmd", ""),
      invariantPassportJsons: readRepeatedFlag(collectArgs, "invariant-passport-json"),
      invariantPassportCommand: readFlag(collectArgs, "invariant-passport-cmd", ""),
      kfdAgentHubEvidenceJson: readFlag(collectArgs, "kfd-agent-hub-evidence-json", ""),
      basePassportJson: readFlag(collectArgs, "base-passport-json", ""),
      requireBaseKfd: readBooleanFlag(collectArgs, "require-base-kfd"),
      releaseJsonExtra: readFlag(collectArgs, "release-extra-json", ""),
      publishJson: readFlag(collectArgs, "publish-json", ""),
      workflow,
    });
    if (readBooleanFlag(collectArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`release passport collected: ${path.relative(process.cwd(), result.outputDir)}\n`);
      process.stdout.write(`artifacts: ${result.artifactEvidence.artifacts.length}\n`);
    }
    return;
  }

  if (command === "project") {
    const [subcommand = "", location = "", ...projectArgs] = args;
    if (subcommand !== "kfx-admission" || !location) {
      throw new Error("usage: buildchain project kfx-admission <file-or-json>");
    }
    const projection = projectArtifactVerificationEnvelopeToKfx({
      envelope: readJsonInput(location, { label: "artifact verification envelope" }),
      ...artifactEnvelopeOptions(projectArgs),
    });
    if (readBooleanFlag(projectArgs, "json")) {
      printJson(projection);
    } else {
      process.stdout.write(`KFX admission envelope: ${projection.envelopeRoot}\n`);
    }
    return;
  }

  if (command === "verify") {
    const [subcommand = "", location = "", ...verifyArgs] = args;
    if (subcommand === "publication-admission") {
      if (!location) {
        throw new Error("usage: buildchain verify publication-admission <file-or-json> --registry-json <file-or-json> --runner-json <file-or-json> --control-plane-audit-json <file-or-json> --publication-evidence-json <file-or-json>");
      }
      const requiredInput = (name) => {
        const value = readFlag(verifyArgs, name, "");
        if (!value) throw new Error(`buildchain verify publication-admission requires --${name} <file-or-json>`);
        return readJsonInput(value, { label: name });
      };
      const expectedInput = readFlag(verifyArgs, "expected-json", "");
      const capability = verifyPublicationAdmission({
        admission: readJsonInput(location, { label: "publication admission" }),
        registry: requiredInput("registry-json"),
        runnerProvenance: requiredInput("runner-json"),
        controlPlaneAudit: requiredInput("control-plane-audit-json"),
        publicationEvidence: requiredInput("publication-evidence-json"),
        expected: expectedInput ? readJsonInput(expectedInput, { label: "expected-json" }) : {},
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
    if (subcommand === "artifact") {
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
        process.stdout.write(`passport: ${report.passport?.location || report.discovery?.passportLocation || "unresolved"}\n`);
        for (const entry of report.issues) {
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand === "artifact-envelope") {
      if (!location) {
        throw new Error("usage: buildchain verify artifact-envelope <file-or-json>");
      }
      const report = verifyArtifactVerificationEnvelope({
        envelope: readJsonInput(location, { label: "artifact verification envelope" }),
        ...artifactEnvelopeOptions(verifyArgs),
      });
      if (readBooleanFlag(verifyArgs, "json")) {
        printJson(report);
      } else {
        process.stdout.write(`artifact verification envelope: ${report.outcome}\n`);
        process.stdout.write(`root: ${report.envelopeRoot || "unresolved"}\n`);
        for (const entry of report.issues) {
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand === "observability-log") {
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
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand === "infra-contract-evidence-bundle") {
      if (!location) {
        throw new Error("usage: buildchain verify infra-contract-evidence-bundle <file>");
      }
      const bundle = JSON.parse(fs.readFileSync(path.resolve(location), "utf8"));
      const report = verifyInfraContractEvidenceBundle(bundle);
      if (readBooleanFlag(verifyArgs, "json")) {
        printJson(report);
      } else {
        process.stdout.write(`infra contract evidence bundle: ${report.ok ? "ok" : "failed"}\n`);
        process.stdout.write(`artifact: ${report.artifactHash || "unknown"}\n`);
        for (const entry of report.issues) {
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand !== "release-passport" || !location) {
      throw new Error("usage: buildchain verify release-passport <file-or-url>");
    }
    const report = await verifyReleasePassport({ passportLocation: location });
    if (readBooleanFlag(verifyArgs, "json")) {
      printJson(report);
    } else {
      process.stdout.write(`release passport: ${report.ok ? "ok" : "failed"}\n`);
      process.stdout.write(`artifacts: ${report.completeness.artifactCount}\n`);
      for (const entry of report.issues) {
        process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "audit") {
    const [subcommand = "", ...auditArgs] = args;
    if (subcommand === "publication-control-plane") {
      runScript("audit-publication-control-plane.mjs", auditArgs);
      return;
    }
    if (subcommand === "github-governance") {
      runScript("audit-github-governance.mjs", auditArgs);
      return;
    }
    throw new Error("usage: buildchain audit <publication-control-plane|github-governance> ...");
  }

  if (command === "explain") {
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
        githubReleaseBaseUrl: readFlag(explainArgs, "github-release-base-url", ""),
        subjectDigest: readFlag(explainArgs, "subject-digest", ""),
        subjectKind: readFlag(explainArgs, "subject-kind", ""),
        npmRegistryBaseUrl: readFlag(explainArgs, "npm-registry", ""),
        forAudience: readFlag(explainArgs, "for", "human"),
      });
      if (readBooleanFlag(explainArgs, "json")) {
        printJson(explanation);
      } else {
        process.stdout.write(`artifact: ${explanation.subject?.name || subject}\n`);
        process.stdout.write(`trust: ${explanation.trust}\n`);
        process.stdout.write(`next action: ${explanation.nextAction}\n`);
      }
      process.exitCode = explanation.trust === "pass" ? 0 : 1;
      return;
    }
    if (subcommand !== "release") {
      throw new Error("usage: buildchain explain release --passport <file-or-url>");
    }
    const passport = readFlag(explainArgs, "passport", "");
    if (!passport) {
      throw new Error("buildchain explain release requires --passport <file-or-url>");
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

  if (command === "inspect") {
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
        githubReleaseBaseUrl: readFlag(inspectArgs, "github-release-base-url", ""),
        subjectDigest: readFlag(inspectArgs, "subject-digest", ""),
        subjectKind: readFlag(inspectArgs, "subject-kind", ""),
        npmRegistryBaseUrl: readFlag(inspectArgs, "npm-registry", ""),
      });
      printJson(report);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand !== "release") {
      throw new Error("usage: buildchain inspect release --passport <file-or-url>");
    }
    const passport = readFlag(inspectArgs, "passport", "");
    if (!passport) {
      throw new Error("buildchain inspect release requires --passport <file-or-url>");
    }
    const explanation = await explainReleasePassport({
      passportLocation: passport,
      forAudience: readFlag(inspectArgs, "for", "human"),
    });
    printJson(explanation);
    return;
  }

  throw new Error(`unsupported trust or release command: ${command}`);
}

export { TRUST_RELEASE_COMMANDS, dispatchTrustReleaseCommand };
