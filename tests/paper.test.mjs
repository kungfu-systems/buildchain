import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PAPER_MIGRATION_CONTRACT,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
  PAPER_PROVISIONING_CONTRACT,
  PAPER_STATE_ORDER,
  PAPER_VISIBILITY_CONTRACT,
  collectPaperPreflight,
  collectPaperStatus,
  createPaperAlphaPlan,
  createPaperResumePlan,
  executePaperNpmBootstrap,
  planPaperMigration,
  planPaperScaffold,
  writePaperMigration,
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
    buildchainRef: "v2",
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
  assert.equal(firstPlan.summary.create, 14);
  assert.equal(JSON.stringify(firstPlan).includes("_plannedFiles"), false);
  const firstWrite = writePaperScaffold(firstPlan);
  assert.equal(firstWrite.ok, true);
  assert.equal(firstWrite.written.length, 14);
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

test("paper CLI emits stable JSON errors and all eight routes", () => {
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
