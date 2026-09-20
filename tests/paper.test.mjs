import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeCommandShim } from "./helpers/command-shim.mjs";

import {
  PAPER_AGENT_ENTRY_CONTRACT,
  PAPER_AGENT_ENTRY_SECTION_END,
  PAPER_AGENT_ENTRY_SECTION_START,
  collectPaperAgentEntry,
} from "../packages/core/paper/paper-agent-entry.js";
import {
  PAPER_MIGRATION_CONTRACT,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
  PAPER_PROVISIONING_CONTRACT,
  PAPER_STATE_ORDER,
  PAPER_VISIBILITY_CONTRACT,
} from "../packages/core/paper/operations/identity.js";
import {
  collectPaperFleetAudit,
  planPaperFleetUpdate,
  paperFleetTransitionWorkspace,
  writePaperFleetUpdate,
} from "../packages/core/paper/paper-fleet.js";
import { collectPaperPreflight } from "../packages/core/paper/paper.js";
import { collectPaperStatus } from "../packages/core/paper/operations/status.js";

import {
  createPaperWorkStartPlan,
  createPaperWorkSubmitPlan,
  executePaperWorkStart,
  executePaperWorkSubmitPush,
} from "../packages/core/paper/paper-work.js";

import {
  planPaperMigration,
  writePaperMigration,
  planPaperScaffold,
  writePaperScaffold,
} from "../packages/core/paper/operations/scaffold.js";
import {
  legacyPaperVersion,
  writeLegacyPaperFixture,
  refreshLegacyPaperFixture,
} from "./helpers/legacy-paper-fixture.mjs";
import { resolvePaperRuntimeGitSha } from "../packages/core/paper/operations/runtime.js";

test("paper fleet lock refresh temporarily admits the pinned source runtime", () => {
  const workspace =
    "minimumReleaseAgeExclude:\n  - '@example/keep@1.0.0'\n  - '@kungfu-tech/buildchain@3.0.4-alpha.7'\n";
  const lock =
    "packages:\n  '@kungfu-tech/buildchain@3.0.4-alpha.5':\n    resolution: {}\n";
  assert.equal(
    paperFleetTransitionWorkspace(workspace, lock),
    "minimumReleaseAgeExclude:\n  - '@kungfu-tech/buildchain'\n  - '@example/keep@1.0.0'\n",
  );
  assert.equal(paperFleetTransitionWorkspace(workspace, ""), workspace);
});
import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication/publication-sealed-bundle.js";
import {
  attachReleaseTransactionSealedBundle,
  createReleaseTransaction,
  recordReleaseTransactionMilestone,
  transitionReleaseTransaction,
  writeReleaseTransaction,
} from "../packages/core/release/publish-transaction.js";
import { evaluatePaperGithubGovernance } from "../packages/core/paper/commands/paper-work-fleet-cli.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const packageVersion = legacyPaperVersion;

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-paper-${name}-`));
}

function scaffoldOptions(cwd) {
  return {
    cwd,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
    buildchainRef: "v4",
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

test("installed Paper runtime does not inherit the consumer Git head", () => {
  const consumer = tempDir("installed-runtime-consumer");
  initGit(consumer);
  configureGit(consumer);
  fs.writeFileSync(path.join(consumer, "README.md"), "# Consumer\n");
  commitAll(consumer, "initial consumer");
  const consumerHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: consumer,
    encoding: "utf8",
  }).trim();
  const packageRoot = path.join(
    consumer,
    "node_modules",
    "@kungfu-tech",
    "buildchain",
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@kungfu-tech/buildchain", version: "3.0.4-alpha.1" })}\n`,
  );
  const binDir = tempDir("installed-runtime-bin");
  const sourceSha = "a".repeat(40);
  const npm = path.join(binDir, "npm");
  materializeCommandShim(npm, `#!/bin/sh\nprintf '%s\\n' '"${sourceSha}"'\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
  try {
    assert.notEqual(consumerHead, sourceSha);
    assert.equal(
      resolvePaperRuntimeGitSha(packageRoot, "3.0.4-alpha.1"),
      sourceSha,
    );
    const fleet = collectPaperFleetAudit({
      root: consumer,
      repositories: [consumer],
      buildchainRoot: packageRoot,
      buildchainVersion: "3.0.4-alpha.1",
    });
    assert.equal(fleet.runtime.sha, undefined);
    assert.equal(fleet.runtime.source, "not-observed");
  } finally {
    process.env.PATH = originalPath;
  }
});

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

test("retained schema-1 fixture migrates to the shared pipeline while preserving original locks and source", () => {
  const cwd = tempDir("historical-migration");
  writeLegacyPaperFixture(scaffoldOptions(cwd));
  initGit(cwd);
  configureGit(cwd);
  commitAll(cwd, "fixture: retained schema-1 source");
  const preserve = [
    "paper/main.tex",
    ".buildchain/contract-lock.json",
    ".buildchain/alpha-contract-lock.json",
  ];
  const before = preserve.map((file) =>
    fs.readFileSync(path.join(cwd, file), "utf8"),
  );
  const plan = planPaperMigration({ cwd, buildchainRoot: root });
  assert.equal(plan.ok, true);
  assert.equal(writePaperMigration(plan).ok, true);
  for (const [index, file] of preserve.entries())
    assert.equal(fs.readFileSync(path.join(cwd, file), "utf8"), before[index]);
  assert.equal(collectPaperPreflight({ cwd }).ok, true);
  assert.equal(
    fs.existsSync(
      path.join(cwd, ".buildchain/paper/provisioning-authority.json"),
    ),
    false,
  );
});

test("paper agent entry is managed, preserves repository instructions, and fails closed in CI", () => {
  const cwd = tempDir("agent-entry");
  writeLegacyPaperFixture(scaffoldOptions(cwd));
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
  refreshLegacyPaperFixture(cwd);
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
    [bin, "paper", "agent", "verify", "--cwd", cwd, "--offline", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BUILDCHAIN_RUNTIME_SHA: runtimeSha },
    },
  );
  assert.notEqual(
    cliEntry.status,
    0,
    "A retained schema-1 fixture does not qualify the current runtime",
  );
  assert.equal(JSON.parse(cliEntry.stdout).ok, false);

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
  const acceptedAlphaPromotion = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "dev/v0/v0.1",
      GITHUB_BASE_REF: "alpha/v0/v0.1",
    },
  });
  assert.equal(acceptedAlphaPromotion.ok, true);
  const acceptedReleasePromotion = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "alpha/v0/v0.1",
      GITHUB_BASE_REF: "release/v0/v0.1",
    },
  });
  assert.equal(acceptedReleasePromotion.ok, true);
  const acceptedGeneratedVersionState = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "buildchain/version-state/dev-v0-v0.1/ece28683b2bd",
      GITHUB_BASE_REF: "dev/v0/v0.1",
    },
  });
  assert.equal(acceptedGeneratedVersionState.ok, true);
  const wrongGeneratedVersionStateTarget = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "buildchain/version-state/alpha-v0-v0.1/ece28683b2bd",
      GITHUB_BASE_REF: "dev/v0/v0.1",
    },
  });
  assert.equal(wrongGeneratedVersionStateTarget.ok, false);
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
  const skippedChannel = collectPaperAgentEntry({
    cwd,
    buildchainSha: runtimeSha,
    mode: "ci",
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "dev/v0/v0.1",
      GITHUB_BASE_REF: "release/v0/v0.1",
    },
  });
  assert.equal(skippedChannel.ok, false);

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
    /Incomplete or ambiguous legacy Buildchain instructions/,
  );
});

test("paper status reports all explicit states and never infers publication from generated files", () => {
  const cwd = tempDir("status");
  writeLegacyPaperFixture(scaffoldOptions(cwd));
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

test("legacy Paper provisioning receipt inspection still rejects caller drift", () => {
  const cwd = tempDir("authority-drift");
  writeLegacyPaperFixture(scaffoldOptions(cwd));
  initGit(cwd);
  const releasePath = path.join(
    cwd,
    ".github",
    "workflows",
    "public-release-paper.yml",
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
});

test("paper work plans start from exact remote dev truth and submit without force", () => {
  const cwd = tempDir("work-plan");
  const options = {
    ...scaffoldOptions(cwd),
    repository: "kungfu-systems/paper-work-plan",
  };
  assert.equal(writePaperScaffold(planPaperScaffold(options)).ok, true);
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/paper/agent-entry.json")),
    false,
  );
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

test("paper fleet migrates retained consumers to the shared pair and rejects unknown workflow drift", () => {
  const fleetRoot = tempDir("fleet");
  const repositories = ["paper-one", "paper-two"].map((name) => {
    const cwd = path.join(fleetRoot, name);
    fs.mkdirSync(cwd);
    writeLegacyPaperFixture({
      ...scaffoldOptions(cwd),
      name,
      packageName: `@example/${name}`,
      repository: `kungfu-systems/${name}`,
    });
    fs.writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\n# @kungfu-tech/buildchain ${packageVersion}\n`,
    );
    initGit(cwd);
    configureGit(cwd);
    commitAll(cwd, "fixture: retained paper");
    attachCanonicalTestOrigin(cwd, `kungfu-systems/${name}`);
    execFileSync("git", ["branch", "-M", "feature/fleet-update"], { cwd });
    return cwd;
  });
  const options = {
    root: fleetRoot,
    buildchainRoot: root,
    buildchainVersion: packageVersion,
  };
  const before = collectPaperFleetAudit(options);
  assert.equal(before.summary.repositories, 2);
  assert.equal(before.summary.current, 0);
  const plan = planPaperFleetUpdate(options);
  assert.equal(plan.ok, true);
  assert.equal(writePaperFleetUpdate(plan).ok, true);
  for (const cwd of repositories)
    commitAll(cwd, "fixture: migrate shared contract");
  const after = collectPaperFleetAudit(options);
  assert.equal(after.summary.current, 2, JSON.stringify(after));
  const extra = path.join(repositories[1], ".github/workflows/unowned.yml");
  fs.writeFileSync(extra, "jobs: {}\n");
  commitAll(repositories[1], "fixture: unowned workflow");
  assert.equal(planPaperFleetUpdate(options).ok, false);
  assert.equal(collectPaperFleetAudit(options).summary.current, 1);
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
    "paper status",
  ]) {
    assert.match(help, new RegExp(route.replaceAll(" ", "\\s+")));
  }
});

test("retired Paper publication routes reject before external tooling and are absent from help", () => {
  const cwd = tempDir("retired-publication-routes");
  const fakeBin = path.join(cwd, "fake-bin");
  fs.mkdirSync(fakeBin);
  const marker = path.join(cwd, "external-call");
  for (const tool of ["npm", "gh", "git"])
    materializeCommandShim(
      path.join(fakeBin, tool),
      `#!/bin/sh\nprintf '%s\\n' invoked >> '${marker}'\nexit 97\n`,
    );
  const env = { ...process.env, PATH: fakeBin };
  for (const args of [["bootstrap", "npm"], ["build"], ["alpha"], ["resume"]]) {
    const result = spawnSync(
      process.execPath,
      [bin, "paper", ...args, "--cwd", cwd, "--execute", "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      JSON.parse(result.stdout).error.message,
      /Unknown Paper command/,
    );
  }
  assert.equal(fs.existsSync(marker), false);
  const help = execFileSync(process.execPath, [bin, "paper", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.doesNotMatch(help, /paper (?:bootstrap|build|alpha|resume)\b/u);
});
