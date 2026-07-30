#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import { npmPublishDryRun } from "../scripts/npm-publish-dry-run.mjs";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { runReleasePropagationCli } from "../scripts/release-propagation.mjs";
import { runReleaseGovernanceCli } from "../scripts/reconcile-release-governance.mjs";
import { runPublicationArtifactCli } from "../scripts/publication-artifact.mjs";
import { runPublicationPackageCli } from "../scripts/publication-package.mjs";
import { runPublicationReproducibilityCli } from "../scripts/publication-reproducibility.mjs";
import { runPaperCli } from "../scripts/paper.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";
import { detectPackageManager } from "../packages/core/package-manager.js";
import {
  createBuildchainLogger,
  defaultBuildchainLogPath,
  summarizeBuildchainLogEvents,
} from "../packages/core/logging.js";
import {
  explainKfdAgentHub,
  initKfdAgentHub,
  inspectKfdAgentHub,
  testKfdAgentHub,
} from "../packages/core/kfd-agent-hub.js";
import {
  checkBadgeBundleBlock,
  checkReadmeBadgeBlock,
  collectBadgeBundleFacts,
  collectReadmeBadgeFacts,
  readReadme,
  updateBadgeBundleBlock,
  updateReadmeBadgeBlock,
} from "../packages/core/readme-badges.js";
import {
  checkHomebrewTap,
  collectHomebrewTapFacts,
  renderHomebrewFormula,
  updateHomebrewTap,
} from "../packages/core/homebrew.js";
import {
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  formatDiagnosticsSummaryTable,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
} from "../packages/core/diagnostics.js";
import {
  aggregateBuildFacts,
  collectModuleBuildFacts,
  verifyBuildFacts,
  writeBuildFacts,
  writeKungfuBuildInfoProjection,
} from "../packages/core/build-facts.js";
import {
  checkKfdUpstreamFacts,
  collectKfdAggregate,
  collectKfdStatus,
  collectKfdUpstreamFacts,
  kfd1,
  kfd2,
  layout as buildchainLayout,
  listKfdUpstreamRoles,
  listKfdSchemas,
  normalizeKfdStandardId,
  readKfdSchema,
} from "../packages/core/kfd.js";
import {
  auditKfd3Surfaces,
  createKfd3SurfaceWitness,
  detectKfd3Surfaces,
  queryKfd3Capabilities,
  registerKfd3Surfaces,
} from "../packages/core/kfd3-surface-register.js";
import {
  createKfdSupportProjection,
  evaluateKfdProductGate,
  validateKfdProductGateResult,
  validateKfdSupportProjection,
} from "../packages/core/kfd-product-gates.js";
import { createBuildchainLayoutDiscovery } from "../packages/core/buildchain-layout.js";
import { createPortableDevCachePlan, createPortableDevCacheReceipt } from "../packages/core/portable-dev-cache.js";
import {
  createCandidateTimeline,
  formatCandidateTimelineReport,
} from "../packages/core/candidate-timeline.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "./internal/cli-options.mjs";
import {
  TRUST_RELEASE_COMMANDS,
  dispatchTrustReleaseCommand,
} from "./internal/trust-release-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedPackageVersion = process.env.BUILDCHAIN_EMBEDDED_PACKAGE_VERSION || "";
const embeddedSourceSha = process.env.BUILDCHAIN_EMBEDDED_SOURCE_SHA || "";

function usage() {
  return `Usage:
  buildchain --help
  buildchain version
  buildchain layout [--cwd <dir>] [--json]
  buildchain portable-cache plan --manifest <file-or-json> [--output <file>]
                                 [--github-output <file>] [--json]
  buildchain portable-cache receipt --plan <file-or-json> [--matched-key <key>]
                                    [--cache-hit true|false]
                                    [--validation-status pass|fail]
                                    [--validation-reason <text>]
                                    [--cold-fallback-status not-run|passed|failed]
                                    [--output <file>] [--json]
  buildchain candidate timeline --input <file-or-json> [--output <file>] [--json]
  buildchain init [--cwd <dir>] [--type package|native|web-surface|infra-contract|publication-artifact|anchored-package] [--force]
                  [--package-manager pnpm|npm|yarn] [--runner-preset <preset>]
                  [--artifact-name <template>]
  buildchain validate [--cwd <dir>] [--require-version-state]
                      [--require-lifecycle-stages <comma-list>]
  buildchain lifecycle run <stage> [--cwd <dir>] [--required]
                             [--artifact-name <name>] [--artifact-path <path>]...
                             [--manifest-path <path>] [--summary-path <path>]
                             [--process-summary <json>]
  buildchain npm dry-run [--cwd <dir>] [--expected-tag <tag>] [--registry <url>]
                         [--dist-tag <tag>] [--skip-npm-publish-dry-run] [--json]
  buildchain release --dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                 [--tags <comma-list>] [--json]
  buildchain release explain --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                     [--tags <comma-list>] [--json]
  buildchain release dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                      [--tags <comma-list>] [--json]
  buildchain release line open --major <n> --minor <n> [--source-ref <ref>]
                               [--initial-version <version>] [--write] [--json]
  buildchain release-governance reconcile --repository <owner/repo>
                               --branch <dev|alpha|release/vN/vN.N>
                               --candidate-sha <sha> [--apply] [--json]
  buildchain github-governance <plan|apply|rollback|protection-policy-plan|ruleset-policy-plan> ...
  buildchain release <inspect|recover|finalize|abort> ...
  buildchain transaction inspect ...
  buildchain collect github-release --tag <tag> [--repository <owner/repo>]
                                    [--assets-dir <dir>] [--assets-json <json-or-path>]
                                    [--release-json <json-or-path>] [--package-set-json <json-or-path>]
                                    [--product-name <name>]
                                    [--publish-evidence-json <json-or-path>]
                                    [--trusted-publishing-json <json-or-path>]
                                    [--transaction-json <json-or-path>]
                                    [--anchor-manifest-json <json-or-path>]
                                    [--impact-json <json-or-path>]
                                    [--build-summary-json <json-or-path>]
                                    [--build-facts-json <json-or-path>]...
                                    [--platform-manifest-json <json-or-path>]...
                                    [--dist-tag-evidence-json <json-or-path>]
                                    [--kfd-1-witness-json <json-or-path>]...
                                    [--kfd-2-claim-json <json-or-path>]...
                                    [--kfd-3-prebuild-witness-json <json-or-path>]...
                                    [--kfd-3-artifact-witness-json <json-or-path>]...
                                    [--kfd-3-artifact-verify-cmd <command>]
                                    [--kfd-support-matrix-json <json-or-path>]
                                    [--kfd-product-gate-json <json-or-path>]...
                                    [--invariant-passport-json <json-or-path>]...
                                    [--invariant-passport-cmd <command>]
                                    [--github-artifact-attestation-policy-json <json-or-path>]...
                                    [--kfd-agent-hub-evidence-json <json-or-path>]
                                    [--base-passport-json <json-or-path>] [--require-base-kfd]
                                    [--release-extra-json <json-or-path>]
                                    [--publish-json <json-or-path>] [--output-dir <dir>] [--json]
  buildchain create publication-admission --input-json <file-or-json> [--output <file>] [--json]
  buildchain create runner-provenance --input-json <file-or-json> [--output <file>] [--json]
  buildchain create github-artifact-attestation-policy --input-json <file-or-json> [--output <file>] [--json]
  buildchain verify release-passport <file-or-url> [--json]
  buildchain verify github-artifact-attestation <artifact>
                          --evidence <file> --bundle <file>
                          --platform-manifest <file> --release-passport <file> [--json]
  buildchain verify publication-admission <file-or-json>
                          --registry-json <file-or-json>
                          --runner-json <file-or-json>
                          --control-plane-audit-json <file-or-json>
                          --publication-evidence-json <file-or-json>
                          [--expected-json <file-or-json>] [--used-nonce <nonce>]... [--json]
  buildchain audit publication-control-plane --repository <owner/repo> --branch <protected-branch>
  buildchain audit github-governance [--organization <owner>] [--repository <owner/repo>]
                                     [--output <file>] [--require-qualifying] [--json]
                          [--source-sha <merged-branch-sha>] [--workflow-repository <owner/repo>]
                          [--workflow <path>] [--workflow-ref <sha-or-ref>]
                          [--job <id>] [--environment <name>] [--package <name>]
                          [--publisher-mode npm-trusted-publisher|github-token|oidc-role]
                          [--npm-trust-json <file-or-json>]
                          [--provider-audit-json <file>] [--output <file>] [--allow-nonqualifying]
  buildchain verify artifact <file|dir|url|npm:...|oci:...|github-release:...>
                             [--passport <file-or-url>] [--locator-config <json>]
                             [--repository <owner/repo>] [--tag <tag>]
                             [--npm-registry <url>] [--json]
  buildchain verify artifact-envelope <file-or-json> [--assessment-time <epoch>]
                             [--expected-root <sha256:...>] [--expected-issuer <issuer>]
                             [--expected-publisher <publisher>]
                             [--expected-contract <version>] [--json]
  buildchain project kfx-admission <file-or-json> [--assessment-time <epoch>]
                             [--expected-root <sha256:...>] [--expected-issuer <issuer>]
                             [--expected-publisher <publisher>]
                             [--expected-contract <version>] [--json]
  buildchain verify infra-contract-evidence-bundle <file> [--json]
  buildchain verify observability-log <jsonl> [--min-events <n>]
                                             [--require-phase <csv>]
                                             [--require-component <csv>]
                                             [--require-event <csv>] [--allow-errors] [--json]
  buildchain explain release --passport <file-or-url> [--for human|agent] [--json]
  buildchain explain artifact <subject> [--passport <file-or-url>] [--npm-registry <url>] [--for human|agent] [--json]
  buildchain inspect release --passport <file-or-url> [--json]
  buildchain inspect artifact <subject> [--passport <file-or-url>] [--npm-registry <url>] [--json]
  buildchain doctor [--cwd <dir>] [--require-publish-source-lock] [--json]
  buildchain dev merge-queue --repository <owner/repo> --branch <dev/vN/vN.M>
                             [--from-config | --workflow <required-workflow.yml>...] [--cwd <dir>]
                             [--check-response-timeout-minutes <n>]
                             [--max-entries-to-build <n>] [--apply]
  buildchain log <info|warn|error> --event <name> [--phase <phase>]
                 [--component <name>] [--source <name>] [--attribute key=value]...
                 [--path <jsonl>] [--json]
  buildchain log summary [--path <jsonl>] [--json]
  buildchain diagnostics summary <diagnostics.json>... [--artifact <file>]...
                                      [--output <file>] [--json]
  buildchain facts module [--cwd <dir>] [--module <id>] [--module-root <path>]
                          [--version-source <id>] [--output <file>]
                          [--output-path <path>]... [--legacy-kungfu-buildinfo <file>] [--json]
  buildchain facts aggregate [--cwd <dir>] [--product <id>]
                             [--module-fact <file>]... [--artifact <path>]...
                             [--output <file>] [--json]
  buildchain facts verify [--cwd <dir>] --fact <file> [--json]
  buildchain kfd ...
  buildchain kfd hub <init|inspect|test|explain> [--cwd <dir>]
                     [--declaration <path>] [--output-dir <path>]
                     [--write] [--force] [--for agent] [--json]
  buildchain kfd status [--cwd <dir>] [--json]
  buildchain kfd migrate-layout [--cwd <dir>] [--write] [--force] [--json]
  buildchain kfd schema list [--standard kfd-1|kfd-2|kfd-3|kfd-4] [--json]
  buildchain kfd schema show <kfd-1|kfd-2|kfd-3|kfd-4> [--schema <name>] [--json]
  buildchain kfd upstream roles [--json]
  buildchain kfd upstream collect [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd upstream check [--cwd <dir>] [--aggregate-json <file-or-json>] [--json]
  buildchain kfd aggregate [--cwd <dir>] [--json]
  buildchain kfd 1 schema [--schema <name>] [--json]
  buildchain kfd 1 witness [--cwd <dir>] [--source-sha <sha>] [--output <file>] [--json]
  buildchain kfd 1 gate --witness-json <file-or-json>... [--cwd <dir>] [--artifact-root <dir>]
                        [--output <file>] [--json]
  buildchain kfd 1 verify --gate-json <file-or-json> [--json]
  buildchain kfd 2 schema [--schema <name>] [--json]
  buildchain kfd 2 taxonomy --entry-json <file-or-json>... [--kind residualRisk|downgradeReason] [--json]
  buildchain kfd 2 claims [--cwd <dir>] [--output-dir <dir>] [--json]
  buildchain kfd 2 product-claims <check|write|render> [--cwd <dir>] [--registry <path>]
                                      [--output-dir <dir>] [--version <version>]
                                      [--channel <channel>] [--tag <tag>] [--source-sha <sha>] [--json]
  buildchain kfd 2 trust-claims [--claims-json <file-or-json>] [--json]
  buildchain kfd 2 trust-assessment [--assessment-json <file-or-json>] [--json]
  buildchain kfd 3 ...
  buildchain kfd 3 detect [--cwd <dir>] [--kind <kind>]... [--artifact <path>] [--json]
  buildchain kfd 3 register <node-api|python-api|cli|binary|documentation|site-bundle>
                           [--cwd <dir>] [--registry <path>] [--artifact <path>]
                           [--product <name>] [--json]
  buildchain kfd 3 audit [--cwd <dir>] [--registry <path>] [--artifact <path>] [--json]
  buildchain kfd 3 witness [--cwd <dir>] [--registry <path>] [--kind prebuild|artifact]
                            [--source-sha <sha>] [--artifact <path>] [--output <file>] [--json]
  buildchain kfd 3 query [<product>] [--cwd <dir>] [--registry <path>]
                          [--passport <file-or-url>] [--artifact <path>] [--json]
  buildchain kfd 4 schema [--schema <name>] [--json]
  buildchain kfd 4 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 4 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd 5 schema [--schema <name>] [--json]
  buildchain kfd 5 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 5 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd 7 schema [--schema <name>] [--json]
  buildchain kfd 7 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 7 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd support project --matrix-json <file-or-json> --gate-json <file-or-json>...
                                  [--expected-source-sha <sha>] [--checked-at <date-time>]
                                  [--output <file>] [--json]
  buildchain kfd support verify --projection-json <file-or-json>
                                  [--expected-source-sha <sha>] [--checked-at <date-time>] [--json]
  buildchain sample process-tree [--interval-ms <n>] [--label <name>]
                                 [--output <jsonl>] [--summary-output <json>]
                                 [--requested-parallelism <n>] [--json]
                                 -- <command> [args...]
  buildchain mark --event <name> [--phase <phase>] [--component <name>]
                  [--attribute key=value]... [--path <jsonl>] [--json]
  buildchain span --event <name> [--phase <phase>] [--component <name>]
                  [--path <jsonl>] -- <command> [args...]
  buildchain web-surface ...
  buildchain infra-contract ...
  buildchain publication-artifact manifest [--cwd <dir>] [--source-sha <sha>]
                                           [--output <file>] [--passport-output <file>]
                                           [--registry-output <file>] [--source-bundle <file>]
                                           [--no-source-bundle] [--json]
  buildchain publication-artifact npm-package [--cwd <dir>] [--output-dir <dir>] [--package-name <name>] [--json]
  buildchain publication-artifact reproducibility [--cwd <dir>] [--source-sha <sha>]
                                                   [--output <file>] [--promote]
                                                   [--no-toolchain-pull]
                                                   [--allow-unpinned-toolchain] [--json]
  buildchain paper scaffold --package <name> --repository <owner/repo> [--write] [--json]
  buildchain paper preflight [--cwd <dir>] [--offline] [--json]
  buildchain paper bootstrap npm [--cwd <dir>] [--execute]
                                  [--confirm-public-package <name>] [--json]
  buildchain paper build [--cwd <dir>] [--execute] [--json]
  buildchain paper alpha [--cwd <dir>] [--source-ref <ref>] [--target-ref <ref>]
                          [--execute] [--json]
  buildchain paper status [--cwd <dir>] [--json]
  buildchain paper resume [--cwd <dir>] [--buildchain-ref <ref>] [--execute] [--json]
  buildchain release-propagation <plan|write-lock> ...
  buildchain badges readme [--cwd <dir>] [--readme <path>] [--check] [--write] [--json]
  buildchain badges bundle [--cwd <dir>] [--readme <path>] [--claims <csv>] [--check] [--write] [--json]
  buildchain homebrew update-formula --package <name> --release-passport <file-or-url> [--write] [--json]
  buildchain homebrew check [--cwd <dir>] [--package <name>] [--release-passport <file-or-url>] [--json]
  buildchain publish-source <lock|manifest|verify-lock|verify-channel-ref|validate-anchored-release> ...
  buildchain build-contract ...

Examples:
  buildchain init --type package --package-manager pnpm
  buildchain validate --require-version-state --require-lifecycle-stages build,verify
  buildchain lifecycle run build --artifact-path dist --artifact-name "{repo}-{version}-{platform}"
  buildchain npm dry-run --json
  buildchain release --dry-run --target-ref alpha/v3/v3.0
  buildchain release line open --major 3 --minor 1 --source-ref release/v3/v3.0 --json
  buildchain span --event native.build -- cmake --build build
  buildchain collect github-release --tag v3.0.0 --assets-dir dist --output-dir .buildchain/release-passport
  buildchain create publication-admission --input-json admission-input.json --output admission.json
  buildchain create runner-provenance --input-json runner-input.json --output runner.json
  buildchain verify release-passport .buildchain/release-passport/buildchain.release.json
  buildchain verify publication-admission admission.json --registry-json publication-authority-registry.json --runner-json runner.json --control-plane-audit-json control-plane.json --expected-json expected.json --json
  buildchain audit publication-control-plane --repository kungfu-systems/buildchain --branch release/v3/v3.0
  buildchain verify artifact ./dist/buildchain-x86_64-unknown-linux-gnu.tar.gz --passport .buildchain/release-passport/buildchain.release.json
  buildchain verify artifact-envelope .buildchain/kfx/artifact-verification-envelope.json --json
  buildchain project kfx-admission .buildchain/kfx/artifact-verification-envelope.json --json
  buildchain verify infra-contract-evidence-bundle .buildchain/infra-contract-evidence-bundle.json
  buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4 --require-phase build
  buildchain infra-contract --mode plan --source-sha <sha>
  buildchain infra-contract --mode ci --source-sha <sha>
  buildchain infra-contract --mode plan --source-sha <sha> --execute-adapter-commands true
  buildchain infra-contract --mode apply --plan <plan.json> --source-sha <sha> --approval-id <id>
  buildchain infra-contract --mode apply --plan <plan.json> --source-sha <sha> --approval-id <id> --dry-run false --execute-adapter-commands true
  buildchain infra-contract --mode propagation-apply --propagation-plan <plan.json> --dry-run true
  buildchain infra-contract --mode evidence-bundle --artifact <artifact.json> --propagation-result <result.json>
  buildchain publication-artifact manifest --source-sha <sha> --json
  buildchain paper preflight --json
  buildchain paper status --json
  buildchain release-propagation plan --graph graph.json --upstream-release release.json --json
  buildchain kfd status --json
  buildchain kfd schema list --json
  buildchain kfd 1 witness --json
  buildchain kfd 2 claims --json
  buildchain kfd 2 trust-assessment --json
  buildchain kfd upstream collect --json
  buildchain kfd aggregate --json
  buildchain kfd 3 query buildchain --json
`;
}

function readAttributes(args) {
  const attributes = {};
  for (const value of readRepeatedFlag(args, "attribute")) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      attributes[value] = true;
    } else {
      attributes[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }
  return attributes;
}

function defaultCliLogPath(args) {
  return readFlag(args, "path", process.env.BUILDCHAIN_LOG_PATH || defaultBuildchainLogPath({ cwd: process.cwd() }));
}

function cliLogger(args, defaults = {}) {
  return createBuildchainLogger({
    cwd: process.cwd(),
    path: defaultCliLogPath(args),
    console: !readBooleanFlag(args, "quiet"),
    source: readFlag(args, "source", defaults.source || "user"),
    component: readFlag(args, "component", defaults.component || "cli"),
    phase: readFlag(args, "phase", defaults.phase || ""),
  });
}

function checkStatus(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

function runDoctor({ cwd = process.cwd(), requirePublishSourceLock = false } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const checks = [];
  checks.push(checkStatus(fs.existsSync(resolvedCwd), "cwd.exists", "working directory exists", { cwd: resolvedCwd }));
  let validation;
  try {
    validation = validateBuildchainConfig(resolvedCwd);
    checks.push(checkStatus(true, "config.valid", "buildchain.toml is valid", {
      projectType: validation.project?.type || "",
      lifecycleStages: validation.lifecycleStages.map((stage) => stage.name),
    }));
  } catch (error) {
    checks.push(checkStatus(false, "config.valid", error.message));
  }
  try {
    const manager = detectPackageManager(resolvedCwd);
    checks.push(checkStatus(true, "package-manager.detected", `package manager: ${manager.name}`, manager));
  } catch (error) {
    checks.push(checkStatus(false, "package-manager.detected", error.message));
  }
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: resolvedCwd,
    encoding: "utf8",
  });
  checks.push(checkStatus(git.status === 0 && git.stdout.trim() === "true", "git.repository", "directory is a git repository"));
  const workflowPath = path.join(resolvedCwd, ".github", "workflows", "build.yml");
  checks.push(checkStatus(fs.existsSync(workflowPath), "workflow.build", "reusable workflow caller exists", {
    path: ".github/workflows/build.yml",
  }));
  if (validation?.version?.strategy === "anchored" && validation.version.next === "manual") {
    const anchored = validateAnchoredPackageRelease({
      cwd: resolvedCwd,
      requirePublishGateSourceLock: requirePublishSourceLock,
    });
    checks.push(checkStatus(
      anchored.ok,
      "anchored-package-release.valid",
      "anchored package release contract is valid",
      {
        contract: anchored.contract,
        summary: anchored.summary,
        checks: anchored.checks,
      },
    ));
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-doctor",
    cwd: resolvedCwd,
    ok: checks.every((check) => check.status === "pass"),
    checks,
    docsUrl: "https://buildchain.libkungfu.dev/docs/cli",
  };
}

function runScript(scriptName, args) {
  const scriptPath = path.join(root, "scripts", scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

async function runReadmeBadgesCli(args = []) {
  const [subcommand = "", surface = "", ...badgeArgs] = args;
  if (!["readme", "bundle"].includes(subcommand) || (surface && surface.startsWith("--") === false)) {
    throw new Error("usage: buildchain badges <readme|bundle> [--cwd <dir>] [--readme <path>] [--claims <csv>] [--check] [--write] [--json]");
  }
  const effectiveArgs = surface ? [surface, ...badgeArgs] : badgeArgs;
  const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
  const readmePath = readFlag(effectiveArgs, "readme", "README.md");
  const claims = readFlag(effectiveArgs, "claims", "");
  const isBundle = subcommand === "bundle";
  const facts = isBundle
    ? await collectBadgeBundleFacts({ cwd, claims })
    : await collectReadmeBadgeFacts({ cwd });
  const checkBlock = isBundle ? checkBadgeBundleBlock : checkReadmeBadgeBlock;
  const updateBlock = isBundle ? updateBadgeBundleBlock : updateReadmeBadgeBlock;
  const commandLabel = `buildchain badges ${subcommand}`;
  if (readBooleanFlag(effectiveArgs, "json") && !readBooleanFlag(effectiveArgs, "check") && !readBooleanFlag(effectiveArgs, "write")) {
    printJson(facts);
    return;
  }
  const readmeText = readReadme({ cwd, readmePath });
  if (!readmeText) {
    throw new Error(`README not found: ${path.join(cwd, readmePath)}`);
  }
  const check = checkBlock({ readmeText, facts });
  if (readBooleanFlag(effectiveArgs, "write")) {
    const next = updateBlock({ readmeText, facts });
    fs.writeFileSync(path.join(cwd, readmePath), next);
    const result = {
      schemaVersion: 1,
      contract: isBundle ? "kungfu-buildchain-badge-bundle-write" : "kungfu-buildchain-readme-badge-write",
      ok: true,
      changed: next !== readmeText,
      readmePath,
      facts,
    };
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`${commandLabel}: ${result.changed ? "updated" : "current"}\n`);
    }
    return;
  }
  if (readBooleanFlag(effectiveArgs, "check")) {
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(check);
    } else {
      process.stdout.write(`${commandLabel}: ${check.ok ? "ok" : "failed"}\n`);
      if (!check.ok) {
        process.stdout.write(`${check.message}\n`);
      }
    }
    if (!check.ok) {
      process.exitCode = 1;
    }
    return;
  }
  printJson(facts);
}

async function runHomebrewCli(args = []) {
  const [subcommand = "", ...homebrewArgs] = args;
  const cwd = path.resolve(readFlag(homebrewArgs, "cwd", process.cwd()));
  const packageName = readFlag(homebrewArgs, "package", "buildchain");
  const releasePassport = readFlag(homebrewArgs, "release-passport", "");
  const manifestPath = readFlag(homebrewArgs, "manifest", "tap-manifest.json");
  const formulaPath = readFlag(homebrewArgs, "formula", "");
  const json = readBooleanFlag(homebrewArgs, "json");
  if (subcommand === "update-formula") {
    if (!releasePassport) {
      throw new Error("buildchain homebrew update-formula requires --release-passport <file-or-url>");
    }
    if (readBooleanFlag(homebrewArgs, "write")) {
      const result = await updateHomebrewTap({
        cwd,
        packageName,
        releasePassport,
        manifestPath,
        formulaPath,
        write: true,
      });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(`buildchain homebrew update-formula: wrote ${result.written.join(", ")}\n`);
      }
      return;
    }
    const facts = await collectHomebrewTapFacts({
      cwd,
      packageName,
      releasePassport,
      manifestPath,
      formulaPath,
    });
    if (json) {
      printJson({
        schemaVersion: 1,
        contract: "kungfu-buildchain-homebrew-formula-render",
        facts,
        formula: renderHomebrewFormula(facts),
        manifest: facts.manifestProjection,
      });
    } else {
      process.stdout.write(renderHomebrewFormula(facts));
    }
    return;
  }
  if (subcommand === "check") {
    const report = await checkHomebrewTap({
      cwd,
      packageName,
      releasePassport,
      manifestPath,
      formulaPath,
    });
    if (json) {
      printJson(report);
    } else {
      process.stdout.write(`buildchain homebrew check: ${report.ok ? "ok" : "failed"}\n`);
      for (const check of report.checks) {
        process.stdout.write(`- ${check.status}: ${check.id}: ${check.message}\n`);
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain homebrew <update-formula|check> ...");
}

function kfd3Kinds(args = []) {
  return readRepeatedFlag(args, "kind")
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function runKfd3Cli(args = []) {
  const [subcommand = "", maybeKindOrProduct = "", ...rest] = args;
  if (!["detect", "register", "audit", "witness", "query"].includes(subcommand)) {
    throw new Error("usage: buildchain kfd 3 <detect|register|audit|witness|query> ...");
  }
  const effectiveArgs = maybeKindOrProduct && maybeKindOrProduct.startsWith("--") ? [maybeKindOrProduct, ...rest] : rest;
  const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
  const registryPath = readFlag(effectiveArgs, "registry", "");
  const artifactPath = readFlag(effectiveArgs, "artifact", "");
  const json = readBooleanFlag(effectiveArgs, "json");

  if (subcommand === "detect") {
    const result = detectKfd3Surfaces({ cwd, kinds: kfd3Kinds(effectiveArgs), artifactPath });
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 3 detect: ${result.summary.surfaceCount} surfaces\n`);
      for (const entry of result.surfaces) {
        process.stdout.write(`- ${entry.kind}: ${entry.id} (${entry.detectionMethod})\n`);
      }
    }
    return;
  }

  if (subcommand === "register") {
    const registerKind = maybeKindOrProduct && !maybeKindOrProduct.startsWith("--") ? maybeKindOrProduct : "";
    if (!registerKind) {
      throw new Error("usage: buildchain kfd 3 register <node-api|python-api|cli|binary|documentation|site-bundle>");
    }
    const result = registerKfd3Surfaces({
      cwd,
      registryPath,
      kinds: [registerKind],
      artifactPath,
      product: {
        name: readFlag(effectiveArgs, "product", ""),
      },
    });
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 3 register: ${result.registeredCount} ${registerKind} surfaces -> ${registryPath}\n`);
    }
    return;
  }

  if (subcommand === "audit") {
    const report = auditKfd3Surfaces({ cwd, registryPath, kinds: kfd3Kinds(effectiveArgs), artifactPath });
    if (json) {
      printJson(report);
    } else {
      process.stdout.write(`kfd 3 audit: ${report.status}\n`);
      process.stdout.write(`detected=${report.summary.detected} declared=${report.summary.declared} enforced=${report.summary.enforced}\n`);
      for (const issue of report.issues) {
        process.stdout.write(`- ${issue.level}: ${issue.code}: ${issue.surfaceId}\n`);
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "witness") {
    const witness = createKfd3SurfaceWitness({
      cwd,
      registryPath,
      kind: readFlag(effectiveArgs, "kind", "prebuild"),
      sourceSha: readFlag(effectiveArgs, "source-sha", process.env.GITHUB_SHA || ""),
      artifactPath,
    });
    const output = readFlag(effectiveArgs, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), witness);
    }
    if (json || !output) {
      printJson(witness);
    } else {
      process.stdout.write(`kfd 3 witness: wrote ${output}\n`);
    }
    return;
  }

  const product = maybeKindOrProduct && !maybeKindOrProduct.startsWith("--") ? maybeKindOrProduct : readFlag(effectiveArgs, "product", "");
  const result = await queryKfd3Capabilities({
    cwd,
    product,
    registryPath,
    passportLocation: readFlag(effectiveArgs, "passport", ""),
    artifactPath,
  });
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`kfd 3 query: ${result.product} (${result.status || result.kfd?.kfd3 || "unknown"})\n`);
    process.stdout.write(`capabilities: ${result.capabilities?.length || 0}\n`);
    for (const entry of result.capabilities || []) {
      process.stdout.write(`- ${entry.kind}: ${entry.id} [${entry.state || "declared"}]\n`);
    }
  }
}

function printKfdSchemaOrJson({ result, json }) {
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(JSON.stringify(result.schema, null, 2));
    process.stdout.write("\n");
  }
}

function runKfd1Cli(args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({ standard: "kfd-1", schema: readFlag(rest, "schema", "") }),
      json,
    });
    return;
  }
  if (action === "witness") {
    const witness = kfd1.createBuildchainWitness({
      root: cwd,
      sourceSha: readFlag(rest, "source-sha", process.env.GITHUB_SHA || ""),
    });
    const output = readFlag(rest, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), witness);
    }
    if (json || !output) {
      printJson(witness);
    } else {
      process.stdout.write(`kfd 1 witness: wrote ${output}\n`);
    }
    return;
  }
  if (action === "gate") {
    const witnesses = readRepeatedJsonInputs(rest, "witness-json", { cwd, label: "kfd-1 witness" });
    if (witnesses.length === 0) {
      throw new Error("buildchain kfd 1 gate requires at least one --witness-json");
    }
    const gate = kfd1.createReleaseGateEvidence({
      cwd,
      artifactRoot: readFlag(rest, "artifact-root", ""),
      witnesses,
    });
    const output = readFlag(rest, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), gate);
    }
    if (json || !output) {
      printJson(gate);
    } else {
      process.stdout.write(`kfd 1 gate: wrote ${output}\n`);
    }
    return;
  }
  if (action === "verify") {
    const gate = readJsonInput(readFlag(rest, "gate-json", ""), { cwd, label: "kfd-1 gate" });
    const issues = kfd1.validateReleaseGateEvidence(gate);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-1-verify-result",
      ok: issues.length === 0,
      issues,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 1 verify: ${result.ok ? "ok" : "failed"}\n`);
      for (const issue of issues) {
        process.stdout.write(`- ${issue.level || "error"}: ${issue.code || "kfd-1"}: ${issue.message || issue}\n`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain kfd 1 <schema|witness|gate|verify> ...");
}

function runKfd2Cli(args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({ standard: "kfd-2", schema: readFlag(rest, "schema", "") }),
      json,
    });
    return;
  }
  if (action === "taxonomy") {
    const kind = readFlag(rest, "kind", "residualRisk");
    const entries = readRepeatedJsonInputs(rest, "entry-json", { cwd, label: "kfd-2 taxonomy entry" });
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-taxonomy-validation",
      ok: true,
      kind,
      entries: kfd2.validateTaxonomyEntries({ entries, kind }),
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 2 taxonomy: ${result.entries.length} ${kind} entries ok\n`);
    }
    return;
  }
  if (action === "claims") {
    const claims = kfd2.createBuildchainClaims({ root: cwd });
    const outputDir = readFlag(rest, "output-dir", "");
    if (outputDir) {
      for (const claim of claims) {
        const slug = String(claim.id || "claim").replace(/[^a-z0-9._-]+/gi, "-");
        writeJsonFile(path.resolve(cwd, outputDir, `${slug}.json`), claim);
      }
    }
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-claims",
      count: claims.length,
      claims,
    };
    if (json || !outputDir) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 2 claims: wrote ${claims.length} claims to ${outputDir}\n`);
    }
    return;
  }
  if (action === "product-claims") {
    const mode = !rest[0] || rest[0].startsWith("--") ? "check" : rest[0];
    const productArgs = mode === rest[0] ? rest.slice(1) : rest;
    const options = {
      cwd,
      ...(readFlag(productArgs, "registry", "") ? { registryPath: readFlag(productArgs, "registry", "") } : {}),
      ...(readFlag(productArgs, "output-dir", "") ? { outputDir: readFlag(productArgs, "output-dir", "") } : {}),
      version: readFlag(productArgs, "version", ""),
      channel: readFlag(productArgs, "channel", ""),
      tag: readFlag(productArgs, "tag", ""),
      sourceSha: readFlag(productArgs, "source-sha", ""),
    };
    let result;
    if (mode === "check") result = kfd2.checkProductClaimOutputs(options);
    else if (mode === "write") result = kfd2.writeProductClaimOutputs(options);
    else if (mode === "render") result = kfd2.renderProductClaimOutputs(options);
    else throw new Error("usage: buildchain kfd 2 product-claims <check|write|render> ...");
    if (json || mode === "render") {
      printJson(result);
    } else {
      process.stdout.write(`kfd 2 product-claims ${mode}: ${result.ok ? "ok" : "failed"} (${result.summary.claimCount} claims, ${result.status || "rendered"})\n`);
      for (const entry of result.issues || []) {
        process.stdout.write(`- ${entry.level || "error"}: ${entry.code}: ${entry.message}\n`);
      }
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "trust-claims") {
    const document = readFlag(rest, "claims-json", "")
      ? readJsonInput(readFlag(rest, "claims-json", ""), { cwd, label: "kfd-2 trust claims" })
      : kfd2.readFoundationTrustClaims();
    const validation = kfd2.validateTrustClaims(document);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-claims",
      source: readFlag(rest, "claims-json", "") ? "input" : "@kungfu-tech/kfd foundation trust claims",
      document,
      validation,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 2 trust-claims: ${validation.ok ? "ok" : "failed"} (${validation.claimCount} claims)\n`);
    }
    if (!validation.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "trust-assessment") {
    const document = readFlag(rest, "assessment-json", "")
      ? readJsonInput(readFlag(rest, "assessment-json", ""), { cwd, label: "kfd-2 trust assessment" })
      : kfd2.readFoundationTrustAssessment();
    const validation = kfd2.validateTrustAssessment(document);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-assessment",
      source: readFlag(rest, "assessment-json", "") ? "input" : "@kungfu-tech/kfd foundation trust assessment",
      document,
      validation,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 2 trust-assessment: ${validation.ok ? "ok" : "failed"} (${validation.result || "unknown"}, ${validation.assessmentCount} assessments)\n`);
    }
    if (!validation.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain kfd 2 <schema|taxonomy|claims|product-claims|trust-claims|trust-assessment> ...");
}

async function runKfdProductGateCli(standard, args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({ standard, schema: readFlag(rest, "schema", "") }),
      json,
    });
    return;
  }
  if (action === "gate") {
    const inputValue = readFlag(rest, "input-json", "");
    if (!inputValue) {
      throw new Error(`buildchain kfd ${standard.slice(4)} gate requires --input-json <file-or-json>`);
    }
    const result = await evaluateKfdProductGate({
      cwd,
      input: readJsonInput(inputValue, { cwd, label: `${standard} product gate input` }),
      expectedSourceSha: readFlag(rest, "expected-source-sha", ""),
      checkedAt: readFlag(rest, "checked-at", "") || new Date().toISOString(),
    });
    const output = readFlag(rest, "output", "");
    if (output) writeJsonFile(path.resolve(cwd, output), result);
    if (json || !output) {
      printJson(result);
    } else {
      process.stdout.write(`${standard} product gate: ${result.status} -> ${output}\n`);
      for (const entry of result.issues) {
        process.stdout.write(`- ${entry.code}: ${entry.path}: ${entry.message}\n`);
      }
    }
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (action === "verify") {
    const gateValue = readFlag(rest, "gate-json", "");
    if (!gateValue) {
      throw new Error(`buildchain kfd ${standard.slice(4)} verify requires --gate-json <file-or-json>`);
    }
    const gate = readJsonInput(gateValue, { cwd, label: `${standard} product gate result` });
    const validation = validateKfdProductGateResult(gate, {
      expectedSourceSha: readFlag(rest, "expected-source-sha", ""),
      checkedAt: readFlag(rest, "checked-at", "") || new Date().toISOString(),
    });
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-product-gate-verification",
      valid: validation.valid,
      passed: validation.valid && gate.status === "passed",
      standard: gate.standard || standard,
      gateRoot: gate.gateRoot || "",
      issues: validation.issues,
    };
    if (json) printJson(result);
    else process.stdout.write(`${standard} product gate verify: ${result.passed ? "passed" : "failed"}\n`);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`usage: buildchain kfd ${standard.slice(4)} <schema|gate|verify> ...`);
}

function runKfdSupportCli(args = []) {
  const [action = "", ...rest] = args;
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  const checkedAt = readFlag(rest, "checked-at", "") || new Date().toISOString();
  const expectedSourceSha = readFlag(rest, "expected-source-sha", "");
  if (action === "project") {
    const matrixInput = readFlag(rest, "matrix-json", "");
    if (!matrixInput) {
      throw new Error("buildchain kfd support project requires --matrix-json <file-or-json>");
    }
    const matrix = readJsonInput(matrixInput, { cwd, label: "KFD support matrix" });
    const matrixPath = path.resolve(cwd, matrixInput);
    const matrixRoot = fs.existsSync(matrixPath)
      ? `sha256:${crypto.createHash("sha256").update(fs.readFileSync(matrixPath)).digest("hex")}`
      : "";
    const gateResults = readRepeatedJsonInputs(rest, "gate-json", {
      cwd,
      label: "KFD product gate result",
    });
    const result = createKfdSupportProjection({
      matrix,
      matrixRoot,
      gateResults,
      expectedSourceSha,
      checkedAt,
    });
    const output = readFlag(rest, "output", "");
    if (output) writeJsonFile(path.resolve(cwd, output), result);
    if (json || !output) {
      printJson(result);
    } else {
      process.stdout.write(`KFD support projection: ${result.status} -> ${output}\n`);
      for (const entry of result.issues) {
        process.stdout.write(`- ${entry.code}: ${entry.path}: ${entry.message}\n`);
      }
    }
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (action === "verify") {
    const projectionInput = readFlag(rest, "projection-json", "");
    if (!projectionInput) {
      throw new Error("buildchain kfd support verify requires --projection-json <file-or-json>");
    }
    const result = validateKfdSupportProjection(
      readJsonInput(projectionInput, { cwd, label: "KFD support projection" }),
      { expectedSourceSha, checkedAt },
    );
    const report = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-support-projection-verification",
      ok: result.valid,
      issues: result.issues,
    };
    if (json) printJson(report);
    else process.stdout.write(`KFD support projection verify: ${report.ok ? "passed" : "failed"}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  throw new Error("usage: buildchain kfd support <project|verify> ...");
}

async function runKfdCli(args = []) {
  const [subcommand = "", maybeStandardOrAction = "", ...rest] = args;
  if (!subcommand) {
    throw new Error("usage: buildchain kfd <status|migrate-layout|schema|upstream|aggregate|hub|support|1|2|3|4|5|7> ...");
  }

  if (subcommand === "hub") {
    const action = maybeStandardOrAction || "inspect";
    const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
    const declarationPath = readFlag(rest, "declaration", ".buildchain/kfd/agent-hub.json");
    const common = { cwd, declarationPath };
    let result;
    if (action === "init") {
      result = initKfdAgentHub({
        ...common,
        write: readBooleanFlag(rest, "write"),
        force: readBooleanFlag(rest, "force"),
      });
    } else if (action === "inspect") {
      result = inspectKfdAgentHub(common);
    } else if (action === "test") {
      result = testKfdAgentHub({
        ...common,
        outputDir: readFlag(rest, "output-dir", ".buildchain/artifacts/kfd-agent-hub"),
      });
    } else if (action === "explain") {
      result = explainKfdAgentHub(common);
    } else {
      throw new Error("usage: buildchain kfd hub <init|inspect|test|explain> ...");
    }
    if (readBooleanFlag(rest, "json") || readFlag(rest, "for", "") === "agent" || action !== "init") {
      printJson(result);
    } else {
      process.stdout.write(`kfd hub init: ${result.write ? "wrote" : "planned"} ${result.path}\n`);
    }
    if (result.valid === false || result.status === "blocked") process.exitCode = 1;
    return;
  }

  if (subcommand === "status") {
    const effectiveArgs = maybeStandardOrAction && maybeStandardOrAction.startsWith("--") ? [maybeStandardOrAction, ...rest] : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = collectKfdStatus({ cwd });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`kfd status: layout=${result.layout.status}\n`);
      for (const [standard, capabilities] of Object.entries(result.support)) {
        process.stdout.write(`- ${standard}: ${capabilities.join(", ")}\n`);
      }
    }
    return;
  }

  if (subcommand === "migrate-layout") {
    const effectiveArgs = maybeStandardOrAction && maybeStandardOrAction.startsWith("--") ? [maybeStandardOrAction, ...rest] : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = buildchainLayout.migrate({
      cwd,
      write: readBooleanFlag(effectiveArgs, "write"),
      force: readBooleanFlag(effectiveArgs, "force"),
    });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`kfd migrate-layout: ${result.status}${result.write ? " (write)" : " (dry-run)"}\n`);
      for (const move of result.moves) {
        process.stdout.write(`- ${move.from} -> ${move.to}\n`);
      }
    }
    return;
  }

  if (subcommand === "schema") {
    const [schemaCommand = "", maybeStandard = "", ...schemaRest] = [maybeStandardOrAction, ...rest];
    const effectiveArgs = maybeStandard && maybeStandard.startsWith("--") ? [maybeStandard, ...schemaRest] : schemaRest;
    const json = readBooleanFlag(effectiveArgs, "json");
    if (schemaCommand === "list") {
      const result = listKfdSchemas({ standard: readFlag(effectiveArgs, "standard", "") });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(`kfd schema list: ${result.schemas.length} schemas\n`);
        for (const entry of result.schemas) {
          process.stdout.write(`- ${entry.standard}:${entry.name} ${entry.schemaId || entry.schemaPath}\n`);
        }
      }
      return;
    }
    if (schemaCommand === "show") {
      const standard = maybeStandard && !maybeStandard.startsWith("--") ? maybeStandard : readFlag(effectiveArgs, "standard", "");
      if (!standard) {
        throw new Error("usage: buildchain kfd schema show <kfd-1..kfd-13> [--schema <name>]");
      }
      const result = readKfdSchema({ standard, schema: readFlag(effectiveArgs, "schema", "") });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(JSON.stringify(result.schema, null, 2));
        process.stdout.write("\n");
      }
      return;
    }
    throw new Error("usage: buildchain kfd schema <list|show> ...");
  }

  if (subcommand === "upstream") {
    const [action = "", ...upstreamArgs] = [maybeStandardOrAction, ...rest];
    const effectiveAction = action || "collect";
    const cwd = path.resolve(readFlag(upstreamArgs, "cwd", process.cwd()));
    const json = readBooleanFlag(upstreamArgs, "json");
    if (effectiveAction === "roles") {
      const result = listKfdUpstreamRoles();
      if (json) {
        printJson(result);
      } else {
        process.stdout.write("KFD upstream roles:\n");
        for (const entry of result.roles) {
          process.stdout.write(`- ${entry.role}: ${entry.description}\n`);
        }
      }
      return;
    }
    if (effectiveAction === "collect") {
      const result = collectKfdUpstreamFacts({ cwd });
      const output = readFlag(upstreamArgs, "output", "");
      if (output) {
        fs.mkdirSync(path.dirname(path.resolve(cwd, output)), { recursive: true });
        fs.writeFileSync(path.resolve(cwd, output), `${JSON.stringify(result, null, 2)}\n`);
      }
      if (json || !output) {
        printJson(result);
      } else {
        process.stdout.write(`kfd upstream collect: wrote ${output}\n`);
      }
      return;
    }
    if (effectiveAction === "check") {
      const aggregateInput = readFlag(upstreamArgs, "aggregate-json", "");
      const aggregate = aggregateInput
        ? readJsonInput(aggregateInput, { cwd, label: "kfd upstream aggregate" })
        : collectKfdUpstreamFacts({ cwd });
      const result = checkKfdUpstreamFacts(aggregate);
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(`kfd upstream check: ${result.status} (${result.upstreamCount} upstreams)\n`);
        for (const entry of result.issues) {
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error("usage: buildchain kfd upstream <roles|collect|check> ...");
  }

  if (subcommand === "aggregate") {
    const effectiveArgs = maybeStandardOrAction && maybeStandardOrAction.startsWith("--") ? [maybeStandardOrAction, ...rest] : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = collectKfdAggregate({ cwd });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`kfd aggregate: upstream=${result.upstream.summary.upstreamCount}, status=${result.upstreamCheck.status}\n`);
    }
    return;
  }

  if (subcommand === "support") {
    runKfdSupportCli([maybeStandardOrAction, ...rest]);
    return;
  }

  const standard = normalizeKfdStandardId(subcommand);
  if (standard === "kfd-1") {
    runKfd1Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (standard === "kfd-2") {
    runKfd2Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (standard === "kfd-3") {
    await runKfd3Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (["kfd-4", "kfd-5", "kfd-7"].includes(standard)) {
    await runKfdProductGateCli(standard, [maybeStandardOrAction, ...rest]);
    return;
  }
  throw new Error("usage: buildchain kfd <status|migrate-layout|schema|upstream|aggregate|hub|support|1|2|3|4|5|7> ...");
}

async function runBuildFactsCli(args = []) {
  const [subcommand = "", ...factArgs] = args;
  const cwd = path.resolve(readFlag(factArgs, "cwd", process.cwd()));
  if (subcommand === "module") {
    const fact = collectModuleBuildFacts({
      cwd,
      moduleId: readFlag(factArgs, "module", ""),
      moduleRoot: readFlag(factArgs, "module-root", ""),
      versionSourceId: readFlag(factArgs, "version-source", ""),
      outputs: readRepeatedFlag(factArgs, "output-path"),
      lifecycle: readFlag(factArgs, "lifecycle", ""),
      platform: readFlag(factArgs, "platform", "") || undefined,
    });
    const output = readFlag(factArgs, "output", "");
    const writeResult = output ? writeBuildFacts({ cwd, fact, output }) : undefined;
    const legacyOutput = readFlag(factArgs, "legacy-kungfu-buildinfo", "");
    const legacyProjection = legacyOutput
      ? writeKungfuBuildInfoProjection({ cwd, moduleFact: fact, output: legacyOutput })
      : undefined;
    const result = {
      ...fact,
      ...(writeResult ? { written: writeResult } : {}),
      ...(legacyProjection ? { legacyProjection: { path: legacyProjection.path, digest: legacyProjection.digest } } : {}),
    };
    if (readBooleanFlag(factArgs, "json") || !output) {
      printJson(result);
    } else {
      process.stdout.write(`buildchain facts module: ${fact.verification.ok ? "ok" : "failed"} ${writeResult.path}\n`);
    }
    if (!fact.verification.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "aggregate") {
    const fact = aggregateBuildFacts({
      cwd,
      productId: readFlag(factArgs, "product", ""),
      moduleFacts: readRepeatedFlag(factArgs, "module-fact"),
      artifacts: readRepeatedFlag(factArgs, "artifact"),
    });
    const output = readFlag(factArgs, "output", "");
    const writeResult = output ? writeBuildFacts({ cwd, fact, output }) : undefined;
    const result = {
      ...fact,
      ...(writeResult ? { written: writeResult } : {}),
    };
    if (readBooleanFlag(factArgs, "json") || !output) {
      printJson(result);
    } else {
      process.stdout.write(`buildchain facts aggregate: ${fact.verification.ok ? "ok" : "failed"} ${writeResult.path}\n`);
    }
    if (!fact.verification.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "verify") {
    const factPath = readFlag(factArgs, "fact", "");
    if (!factPath) {
      throw new Error("usage: buildchain facts verify --fact <file>");
    }
    const result = verifyBuildFacts({ cwd, factPath });
    if (readBooleanFlag(factArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`buildchain facts verify: ${result.ok ? "ok" : "failed"}\n`);
      for (const issue of result.issues) {
        process.stdout.write(`- ${issue.level}: ${issue.id}: ${issue.message}\n`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain facts <module|aggregate|verify> ...");
}

function appendJsonLine(filePath, value) {
  if (!filePath) {
    return "";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

function readIntegerFlag(args, name, fallback = 0) {
  const value = readFlag(args, name, "");
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function readDiagnosticsArtifactInputs(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--artifact") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("buildchain diagnostics summary --artifact requires a file path");
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (entry === "--output") {
      index += 1;
      continue;
    }
    if (entry === "--json") {
      continue;
    }
    values.push(entry);
  }
  return values;
}

function packageVersion() {
  if (embeddedPackageVersion) {
    return embeddedPackageVersion;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return packageJson.version;
}

function createTailBuffer(limit = 64 * 1024) {
  let value = "";
  return {
    append(chunk) {
      value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (value.length > limit) {
        value = value.slice(value.length - limit);
      }
    },
    text() {
      return value;
    },
  };
}

async function runProcessTreeSample(sampleArgs = []) {
  const separator = sampleArgs.indexOf("--");
  const optionArgs = separator === -1 ? sampleArgs : sampleArgs.slice(0, separator);
  const commandArgs = separator === -1 ? [] : sampleArgs.slice(separator + 1);
  if (commandArgs.length === 0) {
    throw new Error("usage: buildchain sample process-tree -- <command> [args...]");
  }
  const command = commandArgs[0];
  const args = commandArgs.slice(1);
  const label = readFlag(optionArgs, "label", "process-tree");
  const intervalMs = readIntegerFlag(optionArgs, "interval-ms", 15000);
  const requestedParallelism = readIntegerFlag(optionArgs, "requested-parallelism", 0);
  const outputPath = readFlag(optionArgs, "output", ".buildchain/diagnostics/process-samples.jsonl");
  const summaryOutputPath = readFlag(optionArgs, "summary-output", ".buildchain/diagnostics/process-summary.json");
  const startedAt = Date.now();
  const stdoutTail = createTailBuffer();
  const stderrTail = createTailBuffer();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    stdoutTail.append(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail.append(chunk);
    process.stderr.write(chunk);
  });
  const sampler = startProcessSampler({
    rootPid: child.pid || process.pid,
    intervalMs,
    label,
    command,
    args,
    env: process.env,
    requestedParallelism,
    onSample(sample) {
      appendJsonLine(outputPath, sample);
    },
  });
  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error, status: 1, signal: "" }));
    child.on("close", (status, signal) => resolve({ status: status ?? 0, signal: signal || "" }));
  });
  const samples = sampler.stop();
  const summary = summarizeProcessSamples({
    samples,
    command,
    args,
    env: process.env,
    requestedParallelism,
  });
  const report = {
    schemaVersion: 1,
    contract: BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
    label,
    command: path.basename(command),
    argsCount: args.length,
    exit: {
      status: result.status ?? 0,
      signal: result.signal || "",
      error: result.error?.message || "",
    },
    wrappedCommand: {
      command,
      args,
      rootPid: child.pid || 0,
      exitCode: result.status ?? 0,
      signal: result.signal || "",
      error: result.error?.message || "",
      stdoutTail: stdoutTail.text(),
      stderrTail: stderrTail.text(),
    },
    durationMs: Date.now() - startedAt,
    samplesPath: outputPath,
    summaryPath: summaryOutputPath,
    summary,
  };
  writeJsonFile(summaryOutputPath, report);
  if (readBooleanFlag(optionArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(`buildchain process sample: ${summary.sampleCount} samples\n`);
    process.stdout.write(`observed concurrency max: ${summary.observedConcurrency.max}\n`);
    process.stdout.write(`wrote: ${outputPath}\n`);
    process.stdout.write(`wrote: ${summaryOutputPath}\n`);
  }
  if (result.error || result.status !== 0) {
    process.exitCode = result.status || 1;
  }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (command === "layout") {
    const result = createBuildchainLayoutDiscovery({
      cwd: readFlag(args, "cwd", process.cwd()),
      buildchainVersion: packageVersion(),
    });
    if (readBooleanFlag(args, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`Buildchain layout (${result.buildchain.version || "unknown"})\n`);
      process.stdout.write(`- config: ${result.repository.configPath}\n`);
      process.stdout.write(`- KFD-3 registry: ${result.kfd.registries["kfd-3"].path}\n`);
      process.stdout.write(`- Shifu jurisdiction: ${result.shifu.jurisdiction.field}=${result.shifu.jurisdiction.value}\n`);
    }
    return;
  }

  if (command === "portable-cache") {
    const [subcommand = "", ...cacheArgs] = args;
    if (subcommand === "plan") {
      const manifestValue = readFlag(cacheArgs, "manifest", "");
      if (!manifestValue) throw new Error("usage: buildchain portable-cache plan --manifest <file-or-json>");
      const value = createPortableDevCachePlan(readJsonInput(manifestValue, { label: "portable cache manifest" }));
      const output = readFlag(cacheArgs, "output", "");
      if (output) writeJsonFile(path.resolve(output), value);
      const githubOutput = readFlag(cacheArgs, "github-output", "");
      if (githubOutput) {
        const delimiter = `BUILDCHAIN_PORTABLE_CACHE_${crypto.randomBytes(8).toString("hex")}`;
        const fields = {
          "cache-key": value.key,
          "restore-keys": value.restoreKeys.join("\n"),
          "cache-paths": value.paths.join("\n"),
          "plan-digest": value.planDigest,
          "plan-json": JSON.stringify(value),
        };
        const lines = Object.entries(fields).flatMap(([name, field]) => [`${name}<<${delimiter}`, field, delimiter]);
        fs.appendFileSync(path.resolve(githubOutput), `${lines.join("\n")}\n`);
      }
      if (!output || readBooleanFlag(cacheArgs, "json")) printJson(value);
      else process.stdout.write(`portable cache plan: ${output}\n`);
      return;
    }
    if (subcommand === "receipt") {
      const planValue = readFlag(cacheArgs, "plan", "");
      if (!planValue) throw new Error("usage: buildchain portable-cache receipt --plan <file-or-json>");
      const value = createPortableDevCacheReceipt({
        plan: readJsonInput(planValue, { label: "portable cache plan" }),
        matchedKey: readFlag(cacheArgs, "matched-key", ""),
        cacheHit: readFlag(cacheArgs, "cache-hit", ""),
        validationStatus: readFlag(cacheArgs, "validation-status", "pass"),
        validationReason: readFlag(cacheArgs, "validation-reason", ""),
        coldFallbackStatus: readFlag(cacheArgs, "cold-fallback-status", "not-run"),
      });
      const output = readFlag(cacheArgs, "output", "");
      if (output) writeJsonFile(path.resolve(output), value);
      if (!output || readBooleanFlag(cacheArgs, "json")) printJson(value);
      else process.stdout.write(`portable cache receipt: ${output}\n`);
      return;
    }
    throw new Error("usage: buildchain portable-cache <plan|receipt> ...");
  }

  if (command === "candidate") {
    const [subcommand = "", ...candidateArgs] = args;
    if (subcommand !== "timeline") {
      throw new Error("usage: buildchain candidate timeline --input <file-or-json>");
    }
    const inputValue = readFlag(candidateArgs, "input", "");
    if (!inputValue) {
      throw new Error("buildchain candidate timeline requires --input <file-or-json>");
    }
    const input = readJsonInput(inputValue, { label: "candidate timeline input" });
    const timeline = createCandidateTimeline(input);
    const output = readFlag(candidateArgs, "output", "");
    if (output) writeJsonFile(path.resolve(output), timeline);
    if (readBooleanFlag(candidateArgs, "json") || !output) {
      printJson(timeline);
    } else {
      process.stdout.write(`${formatCandidateTimelineReport(timeline)}\n`);
      process.stdout.write(`wrote: ${output}\n`);
    }
    return;
  }

  if (command === "init") {
    const result = initBuildchainRepo({
      cwd: readFlag(args, "cwd", process.cwd()),
      type: readFlag(args, "type", "package"),
      force: readBooleanFlag(args, "force"),
      packageManager: readFlag(args, "package-manager", ""),
      runnerPreset: readFlag(args, "runner-preset", "github-hosted"),
      artifactName: readFlag(args, "artifact-name", "{repo}-{version}-{platform}"),
    });
    printJson(result);
    return;
  }

  if (command === "validate") {
    const lifecycleStages = readFlag(args, "require-lifecycle-stages", "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    printJson(validateBuildchainConfig(readFlag(args, "cwd", process.cwd()), {
      requireVersionState: readBooleanFlag(args, "require-version-state"),
      requireLifecycleStages: lifecycleStages,
    }));
    return;
  }

  if (command === "doctor") {
    const result = runDoctor({
      cwd: readFlag(args, "cwd", process.cwd()),
      requirePublishSourceLock: readBooleanFlag(args, "require-publish-source-lock"),
    });
    if (readBooleanFlag(args, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`buildchain doctor: ${result.ok ? "ok" : "failed"}\n`);
      for (const check of result.checks) {
        process.stdout.write(`- ${check.status}: ${check.id}: ${check.message}\n`);
      }
    }
    return;
  }

  if (command === "dev") {
    const [subcommand = "", ...devArgs] = args;
    if (subcommand !== "merge-queue") {
      throw new Error("usage: buildchain dev merge-queue --repository <owner/repo> --branch <dev/vN/vN.M> [--from-config | --workflow <path>...]");
    }
    runScript("dev-merge-queue.mjs", devArgs);
    return;
  }

  if (command === "log") {
    const [levelOrSubcommand = "info", ...logArgs] = args;
    if (levelOrSubcommand === "summary") {
      const logPath = defaultCliLogPath(logArgs);
      const summary = summarizeBuildchainLogEvents({ path: logPath });
      if (readBooleanFlag(logArgs, "json")) {
        printJson(summary);
      } else {
        process.stdout.write(`buildchain log summary: ${summary.eventCount} events\n`);
        process.stdout.write(`sources: ${Object.keys(summary.sources).join(", ") || "none"}\n`);
        process.stdout.write(`phases: ${Object.keys(summary.phases).join(", ") || "none"}\n`);
        if (summary.controlPlane.eventCount > 0) {
          process.stdout.write(
            `control plane: ${summary.controlPlane.eventCount} events, ` +
            `incident reuse ${summary.controlPlane.workflowFriction.incidentReuseRate ?? "n/a"}, ` +
            `release-intent suppression ${summary.controlPlane.releaseIntent.suppressionRate ?? "n/a"}\n`,
          );
        }
      }
      return;
    }
    if (!["info", "warn", "error"].includes(levelOrSubcommand)) {
      throw new Error("usage: buildchain log <info|warn|error> --event <name>");
    }
    const eventName = readFlag(logArgs, "event", "");
    if (!eventName) {
      throw new Error("buildchain log requires --event <name>");
    }
    const logger = cliLogger(logArgs);
    const event = logger.emit(levelOrSubcommand, eventName, {
      message: readFlag(logArgs, "message", ""),
      attributes: readAttributes(logArgs),
    });
    if (readBooleanFlag(logArgs, "json")) {
      printJson(event);
    }
    return;
  }

  if (command === "diagnostics") {
    const [subcommand = "", ...diagnosticsArgs] = args;
    if (subcommand !== "summary") {
      throw new Error("usage: buildchain diagnostics summary <diagnostics.json>...");
    }
    const inputs = readDiagnosticsArtifactInputs(diagnosticsArgs);
    if (inputs.length === 0) {
      throw new Error("buildchain diagnostics summary requires at least one artifact");
    }
    const summary = summarizeDiagnosticsArtifacts(inputs);
    if (summary.count !== inputs.length) {
      throw new Error(`buildchain diagnostics summary read ${summary.count}/${inputs.length} artifacts`);
    }
    const outputPath = readFlag(diagnosticsArgs, "output", "");
    writeJsonFile(outputPath, summary);
    if (readBooleanFlag(diagnosticsArgs, "json")) {
      printJson(summary);
    } else {
      process.stdout.write(`buildchain diagnostics summary: ${summary.count} platforms\n`);
      process.stdout.write(`warnings: ${summary.totalWarningCount} errors: ${summary.totalErrorCount}\n`);
      if (summary.diagnosticsManifestWarningCount) {
        process.stdout.write(`diagnostics manifest warnings: ${summary.diagnosticsManifestWarningCount}\n`);
      }
      process.stdout.write(`${formatDiagnosticsSummaryTable(summary)}\n`);
      if (outputPath) {
        process.stdout.write(`wrote: ${outputPath}\n`);
      }
    }
    return;
  }

  if (command === "facts") {
    await runBuildFactsCli(args);
    return;
  }

  if (command === "kfd") {
    await runKfdCli(args);
    return;
  }

  if (command === "sample") {
    const [subcommand = "", ...sampleArgs] = args;
    if (subcommand !== "process-tree") {
      throw new Error("usage: buildchain sample process-tree -- <command> [args...]");
    }
    await runProcessTreeSample(sampleArgs);
    return;
  }

  if (command === "mark") {
    const eventName = readFlag(args, "event", "");
    if (!eventName) {
      throw new Error("buildchain mark requires --event <name>");
    }
    const logger = cliLogger(args);
    const event = logger.mark(eventName, {
      message: readFlag(args, "message", ""),
      attributes: readAttributes(args),
    });
    if (readBooleanFlag(args, "json")) {
      printJson(event);
    }
    return;
  }

  if (command === "span") {
    const separator = args.indexOf("--");
    const spanArgs = separator === -1 ? args : args.slice(0, separator);
    const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
    const eventName = readFlag(spanArgs, "event", "");
    if (!eventName || commandArgs.length === 0) {
      throw new Error("usage: buildchain span --event <name> -- <command> [args...]");
    }
    const logger = cliLogger(spanArgs);
    const spanId = crypto.randomUUID();
    const startedAt = Date.now();
    logger.info(`${eventName}.start`, {
      spanId,
      message: readFlag(spanArgs, "message", ""),
      attributes: readAttributes(spanArgs),
    });
    const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    const durationMs = Date.now() - startedAt;
    if (result.error || result.status !== 0) {
      logger.error(`${eventName}.error`, {
        spanId,
        durationMs,
        message: result.error?.message || `command exited with ${result.status ?? "signal"}`,
        attributes: {
          ...readAttributes(spanArgs),
          status: result.status ?? "",
          signal: result.signal || "",
        },
      });
      process.exitCode = result.status ?? 1;
      return;
    }
    logger.info(`${eventName}.end`, {
      spanId,
      durationMs,
      attributes: readAttributes(spanArgs),
    });
    return;
  }

  if (command === "lifecycle") {
    const [subcommand, stageName = "", ...lifecycleArgs] = args;
    if (subcommand !== "run" || !stageName) {
      throw new Error("usage: buildchain lifecycle run <stage>");
    }
    const artifactPaths = readRepeatedFlag(lifecycleArgs, "artifact-path");
    const manifest = runLifecycle({
      cwd: readFlag(lifecycleArgs, "cwd", process.cwd()),
      stageName,
      required: readBooleanFlag(lifecycleArgs, "required"),
      artifactName: readFlag(lifecycleArgs, "artifact-name", "buildchain-artifact"),
      artifactPaths,
      manifestPath: readFlag(lifecycleArgs, "manifest-path", ".buildchain/artifacts/manifest.json"),
      summaryPath: readFlag(lifecycleArgs, "summary-path", ".buildchain/artifacts/summary.json"),
      expectedArtifactsJson: readFlag(lifecycleArgs, "expected-artifacts-json", ""),
      logPath: readFlag(lifecycleArgs, "log-path", process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl"),
      processSummaryPath: readFlag(lifecycleArgs, "process-summary", ""),
      workspace: process.cwd(),
    });
    printJson(manifest);
    return;
  }

  if (command === "npm") {
    const [subcommand = "", ...npmArgs] = args;
    if (subcommand !== "dry-run") {
      throw new Error("usage: buildchain npm dry-run");
    }
    const result = npmPublishDryRun({
      cwd: readFlag(npmArgs, "cwd", process.cwd()),
      expectedTag: readFlag(npmArgs, "expected-tag", ""),
      registry: readFlag(npmArgs, "registry", "https://registry.npmjs.org/"),
      distTag: readFlag(npmArgs, "dist-tag", ""),
      skipNpmPublishDryRun: readBooleanFlag(npmArgs, "skip-npm-publish-dry-run"),
    });
    if (readBooleanFlag(npmArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`npm publish dry-run ok: ${result.package.name}@${result.package.version} -> ${result.distTag}\n`);
      process.stdout.write(`pack entries: ${result.pack.entryCount}\n`);
    }
    return;
  }

  if (TRUST_RELEASE_COMMANDS.has(command)) {
    await dispatchTrustReleaseCommand({ command, args, runScript, packageVersion });
    return;
  }

  if (command === "web-surface") {
    runScript("web-surface.mjs", args);
    return;
  }

  if (command === "infra-contract") {
    runScript("infra-contract.mjs", args);
    return;
  }

  if (command === "publication-artifact" || command === "publication") {
    if (args[0] === "npm-package" || args[0] === "package") {
      runPublicationPackageCli(args.slice(1));
      return;
    }
    if (args[0] === "reproducibility" || args[0] === "reproducible") {
      runPublicationReproducibilityCli(args.slice(1));
      return;
    }
    runPublicationArtifactCli(args);
    return;
  }

  if (command === "paper") {
    await runPaperCli(args, {
      buildchainRoot: root,
      buildchainVersion: packageVersion(),
      buildchainRef: process.env.BUILDCHAIN_RUNTIME_REF || "v2",
      buildchainSha:
        process.env.BUILDCHAIN_RUNTIME_SHA || embeddedSourceSha || "",
    });
    return;
  }

  if (command === "release-propagation") {
    runReleasePropagationCli(args);
    return;
  }

  if (command === "release-governance") {
    await runReleaseGovernanceCli(args);
    return;
  }

  if (command === "github-governance") {
    runScript("reconcile-github-governance.mjs", args);
    return;
  }

  if (command === "badges") {
    await runReadmeBadgesCli(args);
    return;
  }

  if (command === "homebrew") {
    await runHomebrewCli(args);
    return;
  }

  if (command === "build-contract") {
    runScript("resolve-build-contract.mjs", args);
    return;
  }

  if (command === "publish-source") {
    const [mode = "lock", ...publishArgs] = args;
    if (mode === "lock" || mode === "manifest") {
      runScript("resolve-publish-source.mjs", ["--mode", mode, ...publishArgs]);
      return;
    }
    if (mode === "verify-lock") {
      runScript("verify-publish-source-lock.mjs", publishArgs);
      return;
    }
    if (mode === "verify-channel-ref") {
      runScript("verify-publish-channel-ref.mjs", publishArgs);
      return;
    }
    if (mode === "validate-anchored-release") {
      const report = validateAnchoredPackageRelease({
        cwd: readFlag(publishArgs, "cwd", process.cwd()),
        requirePublishGateSourceLock: true,
      });
      if (readBooleanFlag(publishArgs, "json")) {
        printJson(report);
      } else {
        process.stdout.write(`anchored release source lock: ${report.ok ? "ok" : "failed"}\n`);
        for (const entry of report.checks) {
          process.stdout.write(`- ${entry.status}: ${entry.id}: ${entry.message}\n`);
        }
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`unsupported publish-source command: ${mode}`);
  }

  throw new Error(`unsupported buildchain command: ${command}`);
}

main().catch((error) => {
  console.error(`buildchain: ${error.message}`);
  process.exitCode = 1;
});
