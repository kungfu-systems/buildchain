import fs from "node:fs";
import path from "node:path";
import {
  planPaperMigration,
  resolvePaperRuntimeGitSha,
  writePaperMigration,
} from "./paper.js";
import {
  PAPER_PATHS,
  PAPER_WORK_BRANCH_PATTERN,
  paperWorkSource,
  readJson,
  rootedPlan,
  sha256Text,
  stableJson,
  workCheck,
} from "./paper-repository.js";

export const PAPER_FLEET_AUDIT_CONTRACT = "kungfu-buildchain-paper-fleet-audit";
export const PAPER_FLEET_UPDATE_PLAN_CONTRACT =
  "kungfu-buildchain-paper-fleet-update-plan";

export function discoverPaperFleet(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  if (
    !fs.existsSync(resolvedRoot) ||
    !fs.statSync(resolvedRoot).isDirectory()
  ) {
    throw new Error("paper fleet root must be an existing directory");
  }
  return fs
    .readdirSync(resolvedRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("paper-") &&
        fs.existsSync(path.join(resolvedRoot, entry.name, ".git")),
    )
    .map((entry) => path.join(resolvedRoot, entry.name))
    .sort();
}

function plannedManagedSurfaces(options) {
  try {
    const plan = planPaperMigration(options);
    return { changes: plan.changes, error: "" };
  } catch (error) {
    return { changes: [], error: error.message };
  }
}

function legacyBuildchainWorkflowRefs(cwd) {
  const workflowRoot = path.resolve(cwd, ".github", "workflows");
  if (!fs.existsSync(workflowRoot)) return [];
  return fs
    .readdirSync(workflowRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.ya?ml$/i.test(entry.name),
    )
    .filter((entry) =>
      /uses:\s*kungfu-systems\/buildchain\/[^\s]+@v2(?:[-.][^\s]+)?/i.test(
        fs.readFileSync(path.join(workflowRoot, entry.name), "utf8"),
      ),
    )
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function paperFleetEntry({
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainSha,
}) {
  const source = paperWorkSource(cwd);
  const packageJson = readJson(path.resolve(cwd, "package.json")).value || {};
  const pinPath = path.resolve(cwd, PAPER_PATHS.versionPin);
  const lockPath = path.resolve(cwd, "pnpm-lock.yaml");
  const expected = plannedManagedSurfaces({
    cwd,
    buildchainRoot,
    buildchainVersion,
    buildchainSha,
  });
  const managed = expected.changes.map((entry) => ({
    path: entry.path,
    status:
      entry.action === "unchanged"
        ? "current"
        : entry.action === "create"
          ? "missing"
          : "drifted",
    expectedSha256: entry.sha256,
    currentSha256: entry.currentSha256,
  }));
  const dependency =
    packageJson.devDependencies?.["@kungfu-tech/buildchain"] || "";
  const lockText = fs.existsSync(lockPath)
    ? fs.readFileSync(lockPath, "utf8")
    : "";
  const legacyWorkflows = legacyBuildchainWorkflowRefs(cwd);
  const checks = [
    workCheck(
      "repository.canonical-origin",
      source.canonical,
      "Repository identity resolves to the canonical kungfu-systems origin.",
      "git remote -v",
    ),
    workCheck(
      "package.buildchain-v3",
      dependency === buildchainVersion && /^3\./.test(dependency),
      "package.json pins the exact Buildchain v3 runtime.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "package.pnpm-lock",
      Boolean(lockText) &&
        lockText.includes("@kungfu-tech/buildchain") &&
        lockText.includes(buildchainVersion),
      "pnpm-lock.yaml binds the Buildchain dependency.",
      "pnpm install --lockfile-only",
    ),
    workCheck(
      "runtime.version-pin",
      fs.existsSync(pinPath) &&
        fs.readFileSync(pinPath, "utf8").trim() === buildchainVersion,
      "The repository version pin equals the exact Buildchain runtime.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "managed-surfaces.current",
      !expected.error && managed.every((entry) => entry.status === "current"),
      "Every Buildchain-owned paper control surface matches v3.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "workflows.buildchain-v2-absent",
      legacyWorkflows.length === 0,
      "No workflow calls a Buildchain v2 reusable surface.",
      "buildchain paper migrate --write --json",
    ),
  ];
  return {
    name: path.basename(cwd),
    cwd,
    repository: source.repository,
    branch: source.branch,
    head: source.head,
    clean: source.clean,
    package: packageJson.name || "",
    buildchainDependency: dependency,
    expectedError: expected.error,
    managed,
    legacyWorkflows,
    checks,
    ok: checks.every((entry) => entry.status === "pass"),
  };
}

export function collectPaperFleetAudit({
  root = process.cwd(),
  repositories = [],
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainSha = "",
  governance = {},
} = {}) {
  const resolvedRoot = path.resolve(root);
  const paths = (
    repositories.length > 0
      ? repositories.map((entry) => path.resolve(entry))
      : discoverPaperFleet(resolvedRoot)
  ).sort();
  const entries = paths.map((cwd) =>
    paperFleetEntry({ cwd, buildchainRoot, buildchainVersion, buildchainSha }),
  );
  const governanceEntries = entries.map((entry) => ({
    repository: entry.repository,
    ...(governance[entry.repository] || { status: "unobserved" }),
  }));
  const payload = {
    schemaVersion: 1,
    contract: PAPER_FLEET_AUDIT_CONTRACT,
    ok:
      entries.length > 0 &&
      entries.every((entry) => entry.ok) &&
      governanceEntries.every((entry) =>
        ["pass", "unobserved"].includes(entry.status),
      ),
    root: resolvedRoot,
    runtime: {
      version: buildchainVersion,
      sha:
        buildchainSha ||
        resolvePaperRuntimeGitSha(buildchainRoot, buildchainVersion),
    },
    summary: {
      repositories: entries.length,
      current: entries.filter((entry) => entry.ok).length,
      drifted: entries.filter((entry) => !entry.ok).length,
      governanceObserved: governanceEntries.filter(
        (entry) => entry.status !== "unobserved",
      ).length,
    },
    repositories: entries,
    governance: governanceEntries,
  };
  return { ...payload, auditRoot: sha256Text(stableJson(payload)) };
}

export function planPaperFleetUpdate(options = {}) {
  const audit = collectPaperFleetAudit(options);
  const plans = audit.repositories.map((entry) => {
    if (!PAPER_WORK_BRANCH_PATTERN.test(entry.branch)) {
      return {
        contract: "kungfu-buildchain-paper-migration",
        ok: false,
        cwd: entry.cwd,
        dryRun: true,
        error:
          "paper fleet update requires an allowed non-protected work branch",
        changes: [],
      };
    }
    try {
      return planPaperMigration({
        cwd: entry.cwd,
        buildchainRoot: options.buildchainRoot,
        buildchainVersion: options.buildchainVersion,
        buildchainSha: options.buildchainSha,
      });
    } catch (error) {
      return {
        contract: "kungfu-buildchain-paper-migration",
        ok: false,
        cwd: entry.cwd,
        dryRun: true,
        error: error.message,
        changes: [],
      };
    }
  });
  const ok = plans.length > 0 && plans.every((entry) => entry.ok);
  return rootedPlan({
    schemaVersion: 1,
    contract: PAPER_FLEET_UPDATE_PLAN_CONTRACT,
    ok,
    root: audit.root,
    dryRun: true,
    auditRoot: audit.auditRoot,
    runtime: audit.runtime,
    plans,
    nextActions: ok
      ? [
          {
            id: "write-fleet-update",
            command: "buildchain paper fleet update --write --json",
            description:
              "Apply only reviewed Buildchain-owned control surfaces, then refresh each pnpm lockfile.",
          },
        ]
      : [
          {
            id: "repair-blocked-repositories",
            command: "git status --short",
            description:
              "Fleet update requires every target repository to be clean and rooted exactly.",
          },
        ],
  });
}

export function writePaperFleetUpdate(plan) {
  if (!plan || plan.contract !== PAPER_FLEET_UPDATE_PLAN_CONTRACT || !plan.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      results: [],
      errorCode: "paper-fleet-update-blocked",
    };
  }
  const results = plan.plans.map((entry) => writePaperMigration(entry));
  return {
    ...plan,
    ok: results.every((entry) => entry.ok),
    dryRun: false,
    results,
  };
}
