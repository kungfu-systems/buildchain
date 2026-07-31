import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PAPER_AGENT_ENTRY_CONTRACT,
  PAPER_AGENT_ENTRY_SECTION_END,
  PAPER_AGENT_ENTRY_SECTION_START,
  PAPER_MIGRATION_CONTRACT,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
  PAPER_PROVISIONING_CONTRACT,
  PAPER_STATE_ORDER,
  PAPER_VISIBILITY_CONTRACT,
  collectPaperFleetAudit,
  collectPaperAgentEntry,
  collectPaperPreflight,
  collectPaperStatus,
  createPaperAlphaPlan,
  createPaperResumePlan,
  createPaperWorkStartPlan,
  createPaperWorkSubmitPlan,
  executePaperWorkStart,
  executePaperWorkSubmitPush,
  executePaperNpmBootstrap,
  planPaperMigration,
  planPaperFleetUpdate,
  planPaperScaffold,
  writePaperMigration,
  writePaperFleetUpdate,
  writePaperScaffold,
} from "../packages/core/paper.js";
import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication-sealed-bundle.js";
import {
  attachReleaseTransactionSealedBundle,
  createReleaseTransaction,
  recordReleaseTransactionMilestone,
  transitionReleaseTransaction,
  writeReleaseTransaction,
} from "../packages/core/publish-transaction.js";
import { evaluatePaperGithubGovernance } from "../scripts/paper-work-fleet-cli.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-paper-${name}-`));
}

function scaffoldOptions(cwd) {
  return {
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    buildchainRef: "v3",
    name: "paper-contract-test",
    title: "Paper Contract Test",
    packageName: "@example/paper-contract-test",
    repository: "example/paper-contract-test",
    version: "0.1.0-alpha.0",
    siteBaseUrl: "https://papers.example.test",
  };
}

function initGit(cwd) {
  execFileSync("git", ["init", "-q"], { cwd });
}

function configureGit(cwd) {
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], {
    cwd,
  });
}

function commitAll(cwd, message) {
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", message], { cwd });
}

function attachCanonicalTestOrigin(cwd, repository) {
  const bare = tempDir("remote");
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bare });
  const githubUrl = `https://github.com/${repository}.git`;
  execFileSync("git", ["remote", "add", "origin", githubUrl], { cwd });
  execFileSync("git", ["config", `url.file://${bare}/.insteadOf`, githubUrl], {
    cwd,
  });
  return bare;
}

function writeJson(cwd, relativePath, value) {
  const target = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function candidateFile(cwd, relativePath, contents) {
  const target = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return {
    path: relativePath,
    size: fs.statSync(target).size,
    sha256: sha256(fs.readFileSync(target)),
  };
}

test("paper scaffold is idempotent, validates locally, and never overwrites a conflict", () => {
  const cwd = tempDir("scaffold");
  const firstPlan = planPaperScaffold(scaffoldOptions(cwd));
  assert.equal(firstPlan.ok, true);
  assert.equal(firstPlan.summary.create, 17);
  assert.equal(JSON.stringify(firstPlan).includes("_plannedFiles"), false);
  const firstWrite = writePaperScaffold(firstPlan);
  assert.equal(firstWrite.ok, true);
  assert.equal(firstWrite.written.length, 17);
  const provisioning = JSON.parse(
    fs.readFileSync(
      path.join(cwd, ".buildchain", "paper", "provisioning-authority.json"),
      "utf8",
    ),
  );
  assert.equal(provisioning.contract, PAPER_PROVISIONING_CONTRACT);
  assert.equal(provisioning.runtime.ref, provisioning.runtime.resolvedSha);
  assert.equal(
    provisioning.admission.acceptedSha,
    provisioning.runtime.resolvedSha,
  );
  assert.equal(
    provisioning.policy.repositoryActions.defaultWorkflowPermissions,
    "read",
  );
  assert.equal(
    provisioning.policy.repositoryActions.canApprovePullRequestReviews,
    false,
  );
  assert.equal(provisioning.policy.generatedWrites.githubTokenFallback, false);
  assert.equal(provisioning.policy.release.versionState, "not-required");
  assert.equal(provisioning.trustedPublisher.workflow, "paper-release.yml");
  const releaseWorkflow = fs.readFileSync(
    path.join(cwd, ".github", "workflows", "paper-release.yml"),
    "utf8",
  );
  assert.match(
    releaseWorkflow,
    new RegExp(
      `paper-release-sealed\\.yml@${provisioning.runtime.resolvedSha}`,
    ),
  );
  assert.match(
    releaseWorkflow,
    new RegExp(`buildchain-ref: ${provisioning.runtime.resolvedSha}`),
  );
  assert.match(
    releaseWorkflow,
    /permissions:\n      actions: read\n      checks: write\n      contents: read\n      id-token: write\n      issues: write\n      pull-requests: write/,
  );
  assert.match(
    releaseWorkflow,
    /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY: \$\{\{ secrets\.KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /BUILDCHAIN_PROMOTION_TOKEN/);

  initGit(cwd);
  const validation = JSON.parse(
    execFileSync(
      process.execPath,
      [
        bin,
        "validate",
        "--cwd",
        cwd,
        "--require-lifecycle-stages",
        "build,verify",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(validation.project.type, "publication-artifact");
  assert.equal(validation.publish.package, "@example/paper-contract-test");

  const secondWrite = writePaperScaffold(
    planPaperScaffold(scaffoldOptions(cwd)),
  );
  assert.equal(secondWrite.ok, true);
  assert.equal(secondWrite.idempotent, true);
  assert.deepEqual(secondWrite.written, []);

  const readmePath = path.join(cwd, "README.md");
  fs.appendFileSync(readmePath, "\nRepository-owned note.\n");
  fs.rmSync(path.join(cwd, "docs", "MAP.md"));
  const conflictPlan = planPaperScaffold(scaffoldOptions(cwd));
  assert.equal(conflictPlan.ok, false);
  assert.deepEqual(
    conflictPlan.conflicts.map((entry) => entry.path),
    ["README.md"],
  );
  const blockedWrite = writePaperScaffold(conflictPlan);
  assert.equal(blockedWrite.ok, false);
  assert.equal(fs.existsSync(path.join(cwd, "docs", "MAP.md")), false);
  assert.match(fs.readFileSync(readmePath, "utf8"), /Repository-owned note/);

  const cleanCwd = tempDir("preflight");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cleanCwd)));
  initGit(cleanCwd);
  const preflight = collectPaperPreflight({
    cwd: cleanCwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    offline: true,
  });
  assert.equal(preflight.localReady, true);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.readyForExternalMutation, false);
  assert.equal(preflight.provisioning.valid, true);
  assert.equal(
    preflight.provisioning.authorityDigest,
    provisioning.authorityDigest,
  );
  assert.equal(
    preflight.checks.find((entry) => entry.id === "runtime.contract-lock")
      .status,
    "pass",
  );
  assert.equal(
    preflight.checks.find((entry) => entry.id === "runtime.exact-source")
      .status,
    "pass",
  );
  assert.equal(
    preflight.checks.find((entry) => entry.id === "provisioning.authority")
      .status,
    "pass",
  );
});

test("paper migration converges existing repositories without rewriting content or config", () => {
  const cwd = tempDir("migration");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], {
    cwd,
  });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "fixture: existing paper"], {
    cwd,
  });

  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  const originalConfig = fs
    .readFileSync(configPath, "utf8")
    .replace(/\n\[lifecycle\.build\]\ncommand = "make pdf"\n/, "\n");
  fs.writeFileSync(configPath, originalConfig);
  fs.rmSync(
    path.join(cwd, ".buildchain", "paper", "provisioning-authority.json"),
  );
  fs.writeFileSync(
    path.join(cwd, ".github", "workflows", "verify.yml"),
    "jobs:\n  check:\n    uses: kungfu-systems/buildchain/.github/workflows/check.yml@v2-alpha\n",
  );
  const runtimeSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  for (const workflow of [
    path.join(cwd, ".github", "workflows", "build.yml"),
    path.join(cwd, ".github", "workflows", "paper-release.yml"),
  ]) {
    fs.writeFileSync(
      workflow,
      fs.readFileSync(workflow, "utf8").replaceAll(runtimeSha, "v2"),
    );
  }
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "fixture: legacy authority"], {
    cwd,
  });

  const contentBefore = fs.readFileSync(
    path.join(cwd, "paper", "main.tex"),
    "utf8",
  );
  const configBefore = fs.readFileSync(configPath, "utf8");
  const plan = planPaperMigration({
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
  });
  assert.equal(plan.contract, PAPER_MIGRATION_CONTRACT);
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.create, 1);
  assert.ok(plan.summary.update >= 2);
  const migrated = writePaperMigration(plan);
  assert.equal(migrated.ok, true);
  assert.equal(
    fs.readFileSync(path.join(cwd, "paper", "main.tex"), "utf8"),
    contentBefore,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  assert.match(
    fs.readFileSync(
      path.join(cwd, ".github", "workflows", "verify.yml"),
      "utf8",
    ),
    new RegExp(`check\\.yml@${runtimeSha}`),
  );
  const migratedLock = JSON.parse(
    fs.readFileSync(
      path.join(cwd, ".buildchain", "contract-lock.json"),
      "utf8",
    ),
  );
  assert.equal(migratedLock.buildchain.ref, "v3");
  assert.notEqual(
    migratedLock.buildchain.acceptedAt,
    "1970-01-01T00:00:00.000Z",
  );
  const preflight = collectPaperPreflight({
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    offline: true,
  });
  assert.equal(
    preflight.checks.find((entry) => entry.id === "config.publication").status,
    "pass",
  );
  assert.equal(
    preflight.checks.find((entry) => entry.id === "provisioning.authority")
      .status,
    "pass",
  );
});

test("paper agent entry is managed, preserves repository instructions, and fails closed in CI", () => {
  const cwd = tempDir("agent-entry");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);
  configureGit(cwd);
  commitAll(cwd, "fixture: scaffold paper agent entry");

  const runtimeSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const entry = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "contract",
  });
  assert.equal(entry.contract, PAPER_AGENT_ENTRY_CONTRACT);
  assert.equal(entry.ok, true);
  const agentsPath = path.join(cwd, "AGENTS.md");
  const originalAgents = fs.readFileSync(agentsPath, "utf8");
  assert.match(originalAgents, new RegExp(PAPER_AGENT_ENTRY_SECTION_START));
  assert.match(originalAgents, new RegExp(PAPER_AGENT_ENTRY_SECTION_END));

  fs.writeFileSync(
    agentsPath,
    `Repository-owned instruction.\n\n${originalAgents}`,
  );
  commitAll(cwd, "docs: retain repository-owned instruction");
  const migration = planPaperMigration({
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    buildchainSha: runtimeSha,
  });
  assert.equal(migration.ok, true);
  writePaperMigration(migration);
  const migratedAgents = fs.readFileSync(agentsPath, "utf8");
  assert.match(migratedAgents, /^Repository-owned instruction\./);
  assert.equal(
    migratedAgents.split(PAPER_AGENT_ENTRY_SECTION_START).length - 1,
    1,
  );

  commitAll(cwd, "chore: migrate paper agent entry");
  const remote = tempDir("agent-entry-remote");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["branch", "-M", "dev/v0/v0.1"], { cwd });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd });
  execFileSync("git", ["push", "-u", "origin", "dev/v0/v0.1"], { cwd });
  execFileSync("git", ["switch", "-c", "feature/agent-entry"], { cwd });
  const cliEntry = spawnSync(
    process.execPath,
    [
      bin,
      "paper",
      "agent",
      "verify",
      "--cwd",
      cwd,
      "--offline",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cliEntry.status, 0, cliEntry.stderr || cliEntry.stdout);
  assert.equal(JSON.parse(cliEntry.stdout).ok, true);

  const acceptedCi = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/agent-entry",
      GITHUB_BASE_REF: "dev/v0/v0.1",
    },
  });
  assert.equal(acceptedCi.ok, true);
  const wrongBase = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/agent-entry",
      GITHUB_BASE_REF: "main",
    },
  });
  assert.equal(wrongBase.ok, false);
  assert.equal(
    wrongBase.checks.find((check) => check.id === "agent-entry.work-context")
      .status,
    "fail",
  );

  const packagePath = path.join(cwd, "package.json");
  const packageText = fs.readFileSync(packagePath, "utf8");
  const packageJson = JSON.parse(packageText);
  packageJson.scripts["paper:work:submit"] = "git push --force";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const bypass = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "contract",
  });
  assert.equal(bypass.ok, false);
  assert.equal(
    bypass.checks.find(
      (check) => check.id === "agent-entry.script.paper:work:submit",
    ).status,
    "fail",
  );

  fs.writeFileSync(packagePath, packageText);
  fs.writeFileSync(
    agentsPath,
    migratedAgents.replace(PAPER_AGENT_ENTRY_SECTION_END, ""),
  );
  commitAll(cwd, "fixture: malformed managed section");
  assert.throws(
    () =>
      planPaperMigration({
        cwd,
        buildchainRoot: root,
        buildchainVersion: packageVersion,
        buildchainSha: runtimeSha,
      }),
    /incomplete Buildchain Paper agent-entry managed section/,
  );
});

test("paper status reports all explicit states and never infers publication from generated files", () => {
  const cwd = tempDir("status");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);

  const initial = collectPaperStatus({ cwd });
  assert.deepEqual(
    initial.states.map((entry) => entry.id),
    PAPER_STATE_ORDER,
  );
  assert.equal(
    initial.states.find((entry) => entry.id === "scaffolded").status,
    "satisfied",
  );
  assert.equal(
    initial.states.find((entry) => entry.id === "governed").status,
    "satisfied",
  );
  assert.equal(
    initial.states.find((entry) => entry.id === "bootstrapped").status,
    "not-reached",
  );
  assert.equal(
    initial.states.find((entry) => entry.id === "package-published").status,
    "not-reached",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain", "publication", "npm-package"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(cwd, ".buildchain", "publication", "npm-package", "package.json"),
    "{}\n",
  );
  const stillUnpublished = collectPaperStatus({ cwd });
  assert.equal(
    stillUnpublished.states.find((entry) => entry.id === "bootstrapped").status,
    "not-reached",
  );
  assert.equal(
    stillUnpublished.states.find((entry) => entry.id === "package-published")
      .status,
    "not-reached",
  );

  writeJson(cwd, ".buildchain/admitted/publication-capability.json", {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publication-capability",
    decision: "allow",
    capabilityDigest: "a".repeat(64),
  });
  const npmReceipt = {
    schemaVersion: 1,
    contract: PAPER_NPM_BOOTSTRAP_CONTRACT,
    package: { name: "@example/paper-contract-test" },
    publish: { status: "published" },
    trust: { status: "configured" },
  };
  writeJson(cwd, ".buildchain/paper/npm-bootstrap.json", npmReceipt);
  writeJson(cwd, ".buildchain/paper/npm-trust.json", npmReceipt);
  writeJson(cwd, ".buildchain/publication/reproducibility-receipt.json", {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publication-reproducibility-receipt",
    status: "passed",
    qualifying: true,
    receiptDigest: `sha256:${"b".repeat(64)}`,
  });

  const npm = candidateFile(
    cwd,
    ".buildchain/publication/npm-tarball/paper-0.1.0-alpha.0.tgz",
    "exact npm bytes",
  );
  const pdf = candidateFile(cwd, "_build/main.pdf", "exact pdf bytes");
  const candidatePayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: "example/paper-contract-test",
    sourceSha: "1".repeat(40),
    sourceTreeSha: "2".repeat(40),
    runtimeSha: "3".repeat(40),
    manifestDigest: "4".repeat(64),
    passportDigest: "5".repeat(64),
    controllerReceiptDigest: "6".repeat(64),
    files: [npm, pdf].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: publicationArtifactCandidateDigest(candidatePayload),
  };
  const bundle = createPublicationSealedBundle({
    candidate,
    packageName: "@example/paper-contract-test",
    packageVersion: "0.1.0-alpha.0",
    npmTarballPath: npm.path,
    npmIntegrity: `sha512-${crypto.createHash("sha512").update("exact npm bytes").digest("base64")}`,
    releaseAssetPaths: [pdf.path],
  });
  writeJson(cwd, ".buildchain/admitted/sealed-bundle.json", bundle);

  let transaction = createReleaseTransaction({
    repository: "example/paper-contract-test",
    version: "v0.1.0-alpha.0",
    channel: "alpha",
    sourceSha: "1".repeat(40),
    targetRef: "alpha/v0/v0.1",
    releaseSha: "7".repeat(40),
  });
  transaction = attachReleaseTransactionSealedBundle(transaction, bundle);
  transaction = transitionReleaseTransaction(transaction, "publishing");
  transaction = transitionReleaseTransaction(transaction, "published");
  transaction = recordReleaseTransactionMilestone(
    transaction,
    "package-published",
  );
  transaction = recordReleaseTransactionMilestone(
    transaction,
    "github-release",
    {
      status: "complete",
    },
  );
  transaction = transitionReleaseTransaction(transaction, "finalizing");
  transaction = transitionReleaseTransaction(transaction, "complete");
  writeReleaseTransaction(
    path.join(cwd, ".buildchain", "release-state", "v0.1.0-alpha.0.json"),
    transaction,
  );
  writeJson(cwd, ".buildchain/paper/visibility.json", {
    schemaVersion: 1,
    contract: PAPER_VISIBILITY_CONTRACT,
    channels: {
      staging: {
        status: "visible",
        url: "https://staging.example.test/paper/",
        evidenceDigest: `sha256:${"8".repeat(64)}`,
      },
      production: {
        status: "visible",
        url: "https://example.test/paper/",
        evidenceDigest: `sha256:${"9".repeat(64)}`,
      },
    },
  });

  const complete = collectPaperStatus({ cwd });
  assert.deepEqual(
    complete.states.filter((entry) => entry.satisfied).map((entry) => entry.id),
    PAPER_STATE_ORDER,
  );
  assert.equal(complete.highestEvidenceState, "production-visible");
  assert.equal(complete.transaction.publicationState, "alpha-complete");
});

test("paper Alpha and resume plans preserve protected workflow boundaries", () => {
  const cwd = tempDir("plans");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);
  const alpha = createPaperAlphaPlan({ cwd });
  assert.equal(alpha.source.ref, "dev/v0/v0.1");
  assert.equal(alpha.target.ref, "alpha/v0/v0.1");
  assert.equal(alpha.mutation.directPublish, false);
  assert.equal(alpha.mutation.directMerge, false);
  assert.match(alpha.mutation.command, /gh pr create/);

  const noTransaction = createPaperResumePlan({ cwd });
  assert.equal(noTransaction.resumable, false);
  assert.equal(noTransaction.reason, "no-release-transaction");
  assert.match(noTransaction.nextActions[0].command, /paper alpha/);
});

test("paper Alpha plans prefer remote-tracking channel truth over stale local branches", () => {
  const cwd = tempDir("alpha-remote-truth");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], {
    cwd,
  });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "test: initialize paper"], { cwd });
  execFileSync("git", ["branch", "dev/v0/v0.1"], { cwd });
  execFileSync(
    "git",
    ["update-ref", "refs/remotes/origin/dev/v0/v0.1", "HEAD"],
    { cwd },
  );
  fs.writeFileSync(path.join(cwd, "remote-only.txt"), "remote\n");
  execFileSync("git", ["add", "remote-only.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "test: advance remote truth"], { cwd });
  execFileSync(
    "git",
    ["update-ref", "refs/remotes/origin/dev/v0/v0.1", "HEAD"],
    { cwd },
  );
  execFileSync(
    "git",
    ["update-ref", "refs/remotes/origin/alpha/v0/v0.1", "HEAD^"],
    { cwd },
  );

  const alpha = createPaperAlphaPlan({ cwd });
  assert.equal(
    alpha.source.sha,
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim(),
  );
  assert.equal(alpha.source.observation, "origin-tracking-ref");
  assert.equal(alpha.source.observedRef, "refs/remotes/origin/dev/v0/v0.1");
  assert.equal(alpha.target.observation, "origin-tracking-ref");
  assert.equal(alpha.target.observedRef, "refs/remotes/origin/alpha/v0/v0.1");
});

test("paper npm bootstrap dry-run uses only a minimal temporary package", () => {
  const cwd = tempDir("npm-bootstrap");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  const result = executePaperNpmBootstrap({
    cwd,
    offline: true,
  });
  assert.equal(result.contract, PAPER_NPM_BOOTSTRAP_CONTRACT);
  assert.equal(result.dryRun, true);
  assert.equal(result.externalMutation, false);
  assert.equal(result.dryRunChecks.minimalPackageOnly, true);
  assert.equal(result.dryRunChecks.pack.status, "pass");
  assert.equal(result.dryRunChecks.publish.status, "pass");
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain", "paper", "npm-bootstrap.json")),
    false,
  );
  assert.throws(
    () =>
      executePaperNpmBootstrap({
        cwd,
        registry: "https://registry.example.test/",
        offline: true,
      }),
    /requires the official registry/,
  );
  assert.throws(
    () =>
      executePaperNpmBootstrap({
        cwd,
        bootstrapVersion: "0.0.0-bootstrap.1",
        offline: true,
      }),
    /version is fixed at 0\.0\.0-bootstrap\.0/,
  );
});

test("paper provisioning authority rejects caller drift and requires exact npm trust", () => {
  const cwd = tempDir("authority-drift");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(cwd)));
  initGit(cwd);
  const releasePath = path.join(
    cwd,
    ".github",
    "workflows",
    "paper-release.yml",
  );
  fs.appendFileSync(releasePath, "\n# unadmitted drift\n");
  const drifted = collectPaperPreflight({
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    offline: true,
  });
  assert.equal(drifted.provisioning.valid, false);
  assert.equal(
    drifted.checks.find((entry) => entry.id === "provisioning.authority")
      .status,
    "fail",
  );

  const trustedCwd = tempDir("exact-trust");
  writePaperScaffold(planPaperScaffold(scaffoldOptions(trustedCwd)));
  const fakeBin = path.join(trustedCwd, "fake-bin");
  fs.mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, "npm");
  fs.writeFileSync(
    fakeNpm,
    `#!/bin/sh
case "$1 $2" in
  "view @example/paper-contract-test") printf '"0.0.0-bootstrap.0"\\n' ;;
  "whoami --registry=https://registry.npmjs.org/") printf 'paper-owner\\n' ;;
  "pack --dry-run") printf '[{"files":[{"path":"package.json"}]}]\\n' ;;
  "publish --dry-run") printf '{}\\n' ;;
  "trust github") printf '{}\\n' ;;
  "trust list")
    printf '%s\\n' "\${FAKE_NPM_TRUST_JSON:-[]}"
    ;;
  *) echo "unexpected npm invocation: $*" >&2; exit 2 ;;
esac
`,
  );
  fs.chmodSync(fakeNpm, 0o755);
  const originalPath = process.env.PATH;
  const originalTrust = process.env.FAKE_NPM_TRUST_JSON;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    process.env.FAKE_NPM_TRUST_JSON = JSON.stringify([
      {
        type: "github",
        repository: "example/another-paper",
        workflow: "paper-release.yml",
        environment: "",
      },
    ]);
    const mismatch = executePaperNpmBootstrap({
      cwd: trustedCwd,
      execute: true,
      confirmedPackage: "@example/paper-contract-test",
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.trust.status, "failed");
    assert.equal(mismatch.trust.exactBinding, false);

    process.env.FAKE_NPM_TRUST_JSON = JSON.stringify([
      {
        type: "github",
        repository: "example/paper-contract-test",
        workflow: "paper-release.yml",
        environment: "",
      },
    ]);
    const exact = executePaperNpmBootstrap({
      cwd: trustedCwd,
      execute: true,
      confirmedPackage: "@example/paper-contract-test",
    });
    assert.equal(exact.ok, true);
    assert.equal(exact.package.existsAfter, true);
    assert.equal(exact.trust.status, "configured");
    assert.equal(exact.trust.exactBinding, true);
    assert.equal(
      exact.authority.digest,
      JSON.parse(
        fs.readFileSync(
          path.join(
            trustedCwd,
            ".buildchain",
            "paper",
            "provisioning-authority.json",
          ),
          "utf8",
        ),
      ).authorityDigest,
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalTrust === undefined) delete process.env.FAKE_NPM_TRUST_JSON;
    else process.env.FAKE_NPM_TRUST_JSON = originalTrust;
  }
});

test("paper work plans start from exact remote dev truth and submit without force", () => {
  const cwd = tempDir("work-plan");
  const options = {
    ...scaffoldOptions(cwd),
    repository: "kungfu-systems/paper-work-plan",
  };
  writePaperScaffold(planPaperScaffold(options));
  initGit(cwd);
  configureGit(cwd);
  commitAll(cwd, "test: initialize paper");
  attachCanonicalTestOrigin(cwd, options.repository);
  execFileSync("git", ["branch", "-M", "dev/v0/v0.1"], { cwd });
  execFileSync("git", ["push", "-u", "origin", "dev/v0/v0.1"], { cwd });

  const start = createPaperWorkStartPlan({
    cwd,
    topic: "golden-path",
  });
  assert.equal(start.ok, true);
  assert.equal(start.target.branch, "feature/golden-path");
  assert.equal(start.mutation.force, false);
  assert.match(start.planRoot, /^sha256:[0-9a-f]{64}$/);
  const started = executePaperWorkStart(start);
  assert.equal(started.ok, true);
  assert.equal(started.created, true);

  fs.writeFileSync(path.join(cwd, "work.txt"), "work\n");
  commitAll(cwd, "test: add paper work");
  const wrongTarget = createPaperWorkSubmitPlan({
    cwd,
    pullRequests: [
      {
        headRefName: "feature/golden-path",
        baseRefName: "main",
        url: "https://example.test/wrong",
      },
    ],
  });
  assert.equal(wrongTarget.ok, false);
  assert.equal(
    wrongTarget.checks.find((entry) => entry.id === "pull-request.target")
      .status,
    "fail",
  );
  const unobservedPullRequests = createPaperWorkSubmitPlan({
    cwd,
    pullRequestObservation: { ok: false },
  });
  assert.equal(unobservedPullRequests.ok, false);
  assert.equal(
    unobservedPullRequests.checks.find(
      (entry) => entry.id === "pull-request.observed",
    ).status,
    "fail",
  );

  const submit = createPaperWorkSubmitPlan({ cwd });
  assert.equal(submit.ok, true);
  assert.equal(submit.mutation.force, false);
  const pushed = executePaperWorkSubmitPush(submit);
  assert.equal(pushed.ok, true);
  assert.equal(pushed.pushed, true);
});

test("paper fleet audit and update converge data-driven worktrees only", () => {
  const fleetRoot = tempDir("fleet");
  const repositories = ["paper-one", "paper-two"].map((name) => {
    const cwd = path.join(fleetRoot, name);
    fs.mkdirSync(cwd);
    writePaperScaffold(
      planPaperScaffold({
        ...scaffoldOptions(cwd),
        name,
        packageName: `@example/${name}`,
        repository: `kungfu-systems/${name}`,
      }),
    );
    fs.writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\n# @kungfu-tech/buildchain ${packageVersion}\n`,
    );
    initGit(cwd);
    configureGit(cwd);
    commitAll(cwd, "test: initialize paper");
    attachCanonicalTestOrigin(cwd, `kungfu-systems/${name}`);
    execFileSync("git", ["branch", "-M", "feature/fleet-update"], { cwd });
    return cwd;
  });

  const current = collectPaperFleetAudit({
    root: fleetRoot,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
  });
  assert.equal(current.summary.repositories, 2);
  assert.equal(current.summary.current, 2, JSON.stringify(current, null, 2));
  assert.match(current.auditRoot, /^sha256:[0-9a-f]{64}$/);

  const verifyPath = path.join(
    repositories[1],
    ".github",
    "workflows",
    "verify.yml",
  );
  fs.writeFileSync(
    verifyPath,
    "jobs:\n  check:\n    uses: kungfu-systems/buildchain/.github/workflows/check.yml@v2-alpha\n",
  );
  commitAll(repositories[1], "test: add legacy workflow drift");
  const legacyWorkflow = collectPaperFleetAudit({
    root: fleetRoot,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
  });
  assert.equal(
    legacyWorkflow.repositories[1].checks.find(
      (entry) => entry.id === "workflows.buildchain-v2-absent",
    ).status,
    "fail",
  );
  fs.writeFileSync(
    verifyPath,
    fs
      .readFileSync(verifyPath, "utf8")
      .replace("@v2-alpha", `@${packageVersion}`),
  );
  commitAll(repositories[1], "test: repair legacy workflow drift");

  const packagePath = path.join(repositories[0], "package.json");
  const driftedPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  driftedPackage.devDependencies["@kungfu-tech/buildchain"] = "2.12.0-alpha.1";
  fs.writeFileSync(packagePath, `${JSON.stringify(driftedPackage, null, 2)}\n`);
  commitAll(repositories[0], "test: add legacy runtime drift");

  const plan = planPaperFleetUpdate({
    root: fleetRoot,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 2);
  const updated = writePaperFleetUpdate(plan);
  assert.equal(updated.ok, true);
  assert.equal(
    JSON.parse(fs.readFileSync(packagePath, "utf8")).devDependencies[
      "@kungfu-tech/buildchain"
    ],
    packageVersion,
  );
});

test("paper fleet governance accepts classic exact-branch protection and requires release", () => {
  const classic = {
    required_status_checks: {
      strict: true,
      contexts: ["check / check"],
      checks: [{ context: "check / check", app_id: 15368 }],
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  const protections = Object.fromEntries(
    ["dev", "alpha", "release"].map((family) => [
      `${family}/v0/v0.1`,
      { ok: true, protection: classic },
    ]),
  );
  const options = {
    repository: "kungfu-systems/paper-kfd-machine-life-roadmap",
    actions: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
    protections,
  };
  const current = evaluatePaperGithubGovernance(options);
  assert.equal(current.status, "pass", JSON.stringify(current, null, 2));
  assert.equal(current.targets.length, 3);

  const missingRelease = evaluatePaperGithubGovernance({
    ...options,
    protections: {
      ...protections,
      "release/v0/v0.1": { ok: false, protection: null },
    },
  });
  assert.equal(missingRelease.status, "fail");
  assert.equal(
    missingRelease.checks.find(
      (entry) => entry.id === "protection.release/v0/v0.1.observed",
    ).status,
    "fail",
  );
});

test("paper CLI emits stable JSON errors and every route", () => {
  const failure = spawnSync(
    process.execPath,
    [bin, "paper", "scaffold", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(failure.status, 0);
  const error = JSON.parse(failure.stdout);
  assert.equal(error.contract, "kungfu-buildchain-paper-error");
  assert.equal(error.error.code, "paper-command-failed");

  const help = execFileSync(process.execPath, [bin, "paper", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  for (const route of [
    "paper scaffold",
    "paper migrate",
    "paper work start",
    "paper work submit",
    "paper fleet audit",
    "paper fleet update",
    "paper agent verify",
    "paper preflight",
    "paper bootstrap npm",
    "paper build",
    "paper alpha",
    "paper status",
    "paper resume",
  ]) {
    assert.match(help, new RegExp(route.replaceAll(" ", "\\s+")));
  }
});
