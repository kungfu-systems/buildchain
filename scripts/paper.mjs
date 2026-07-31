#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PAPER_ALPHA_PLAN_CONTRACT,
  PAPER_BUILD_PLAN_CONTRACT,
  PAPER_MIGRATION_CONTRACT,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
  PAPER_PREFLIGHT_CONTRACT,
  PAPER_RESUME_PLAN_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
  PAPER_STATUS_CONTRACT,
  collectPaperPreflight,
  collectPaperStatus,
  createPaperAlphaPlan,
  createPaperBuildPlan,
  createPaperResumePlan,
  executePaperNpmBootstrap,
  planPaperMigration,
  planPaperScaffold,
  writePaperMigration,
  writePaperScaffold,
} from "../packages/core/paper.js";
import { verifyPublicationReproducibility } from "../packages/core/publication-reproducibility.js";

function usage() {
  return `Usage:
  buildchain paper scaffold --package <name> --repository <owner/repo>
                            [--cwd <dir>] [--name <name>] [--title <title>]
                            [--version <semver>] [--site-base-url <url>]
                            [--buildchain-ref <ref>] [--write] [--json]
  buildchain paper migrate [--cwd <dir>] [--write] [--json]
  buildchain paper preflight [--cwd <dir>] [--offline] [--json]
  buildchain paper bootstrap npm [--cwd <dir>] [--package <name>]
                                  [--repository <owner/repo>] [--workflow <filename>]
                                  [--bootstrap-version <version>] [--userconfig <path>]
                                  [--offline] [--execute]
                                  [--confirm-public-package <name>] [--json]
  buildchain paper build [--cwd <dir>] [--source-sha <sha>]
                          [--no-toolchain-pull] [--keep-workspaces]
                          [--execute] [--json]
  buildchain paper alpha [--cwd <dir>] [--source-ref <ref>] [--target-ref <ref>]
                          [--execute] [--json]
  buildchain paper status [--cwd <dir>] [--json]
  buildchain paper resume [--cwd <dir>] [--buildchain-ref <ref>]
                           [--execute] [--json]

Safety:
  scaffold is a no-overwrite dry-run unless --write is present. migrate only
  rewrites the five Buildchain-owned authority, workflow, lock, and version files.
  npm bootstrap, Alpha PR creation, and resume dispatch never mutate externally
  unless --execute is present. Real npm bootstrap additionally requires the
  exact --confirm-public-package value.
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function commandResult(command, args, { cwd, timeout = 60000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function publicScaffoldPlan(plan) {
  return plan;
}

function humanSummary(result) {
  if (result.contract === PAPER_SCAFFOLD_CONTRACT) {
    process.stdout.write(
      `paper scaffold: ${result.ok ? "ok" : "conflict"} (${result.dryRun ? "dry-run" : "write"})\n`,
    );
    process.stdout.write(
      `create=${result.summary.create} unchanged=${result.summary.unchanged} conflict=${result.summary.conflict}\n`,
    );
    for (const entry of result.changes) {
      process.stdout.write(`- ${entry.action}: ${entry.path}\n`);
    }
    return;
  }
  if (result.contract === PAPER_MIGRATION_CONTRACT) {
    process.stdout.write(
      `paper migrate: ${result.ok ? "ok" : "blocked"} (${result.dryRun ? "dry-run" : "write"})\n`,
    );
    process.stdout.write(
      `create=${result.summary.create} update=${result.summary.update} unchanged=${result.summary.unchanged} conflict=${result.summary.conflict}\n`,
    );
    for (const entry of result.changes) {
      process.stdout.write(`- ${entry.action}: ${entry.path}\n`);
    }
    return;
  }
  if (result.contract === PAPER_PREFLIGHT_CONTRACT) {
    process.stdout.write(
      `paper preflight: ${result.ok ? "ready" : "blocked"}\n`,
    );
    for (const check of result.checks) {
      process.stdout.write(
        `- ${check.status}: ${check.id}: ${check.message}\n`,
      );
    }
    return;
  }
  if (result.contract === PAPER_STATUS_CONTRACT) {
    process.stdout.write(`paper status: ${result.highestEvidenceState}\n`);
    for (const entry of result.states) {
      process.stdout.write(`- ${entry.status}: ${entry.id}: ${entry.reason}\n`);
    }
    return;
  }
  if (result.contract === PAPER_NPM_BOOTSTRAP_CONTRACT) {
    process.stdout.write(
      `paper bootstrap npm: ${result.ok ? result.publish.status : result.errorCode || "blocked"}\n`,
    );
    process.stdout.write(`package: ${result.package.name}\n`);
    process.stdout.write(`trust: ${result.trust.status}\n`);
    for (const url of result.trust.urls || []) {
      process.stdout.write(`url: ${url}\n`);
    }
    return;
  }
  if (result.contract === PAPER_BUILD_PLAN_CONTRACT) {
    process.stdout.write(
      `paper build: ${result.dryRun ? "dry-run" : result.receipt?.status || "complete"}\n`,
    );
    process.stdout.write(`source: ${result.sourceSha}\n`);
    if (result.receipt?.receiptDigest) {
      process.stdout.write(`receipt: ${result.receipt.receiptDigest}\n`);
    }
    return;
  }
  if (result.contract === PAPER_ALPHA_PLAN_CONTRACT) {
    process.stdout.write(
      `paper alpha: ${result.dryRun ? "dry-run" : result.pr?.url || "submitted"}\n`,
    );
    process.stdout.write(`${result.source.ref} -> ${result.target.ref}\n`);
    return;
  }
  if (result.contract === PAPER_RESUME_PLAN_CONTRACT) {
    process.stdout.write(`paper resume: ${result.reason}\n`);
    if (result.mutation?.command) {
      process.stdout.write(`${result.mutation.command}\n`);
    }
    return;
  }
  printJson(result);
}

function printResult(result, json) {
  if (json) printJson(result);
  else humanSummary(result);
}

function githubPrRows({ cwd, repository, sourceRef, targetRef }) {
  const query = commandResult(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      sourceRef,
      "--base",
      targetRef,
      "--state",
      "open",
      "--json",
      "number,url,headRefName,baseRefName",
      "--limit",
      "10",
    ],
    { cwd },
  );
  if (!query.ok) {
    return {
      ok: false,
      rows: [],
      errorCode: query.error ? "gh-unavailable" : "github-pr-query-failed",
    };
  }
  try {
    const rows = JSON.parse(query.stdout || "[]");
    return { ok: true, rows: Array.isArray(rows) ? rows : [], errorCode: "" };
  } catch {
    return { ok: false, rows: [], errorCode: "github-pr-response-invalid" };
  }
}

function githubBranchObservation({ cwd, repository, ref }) {
  const query = commandResult(
    "gh",
    [
      "api",
      `repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`,
      "--jq",
      ".object.sha",
    ],
    { cwd },
  );
  const sha = query.stdout.trim();
  return {
    ok: query.ok && /^[0-9a-f]{40}$/.test(sha),
    ref,
    sha: /^[0-9a-f]{40}$/.test(sha) ? sha : "",
    observedRef: `refs/heads/${ref}`,
    observation: "github-api",
    errorCode: query.ok
      ? "github-ref-response-invalid"
      : query.error
        ? "gh-unavailable"
        : "github-ref-query-failed",
  };
}

function executeAlphaPlan(plan) {
  if (!plan.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      errorCode: "paper-alpha-plan-invalid",
    };
  }
  const source = githubBranchObservation({
    cwd: plan.cwd,
    repository: plan.repository,
    ref: plan.source.ref,
  });
  if (!source.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      errorCode: source.errorCode,
      nextActions: [
        {
          id: "resolve-source-ref",
          command: "",
          description:
            "Resolve the exact protected dev source ref from GitHub before opening an Alpha PR.",
        },
      ],
    };
  }
  const target = githubBranchObservation({
    cwd: plan.cwd,
    repository: plan.repository,
    ref: plan.target.ref,
  });
  if (!target.ok) {
    return {
      ...plan,
      source,
      ok: false,
      dryRun: false,
      errorCode: target.errorCode,
      nextActions: [
        {
          id: "resolve-target-ref",
          command: "",
          description:
            "Resolve the exact protected Alpha target ref from GitHub before opening an Alpha PR.",
        },
      ],
    };
  }
  plan = {
    ...plan,
    source,
    target,
  };
  const existing = githubPrRows({
    cwd: plan.cwd,
    repository: plan.repository,
    sourceRef: plan.source.ref,
    targetRef: plan.target.ref,
  });
  if (!existing.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      errorCode: existing.errorCode,
    };
  }
  if (existing.rows.length > 0) {
    return {
      ...plan,
      ok: true,
      dryRun: false,
      reused: true,
      pr: existing.rows[0],
      nextActions: [
        {
          id: "review-alpha-pr",
          command: "",
          description:
            "Complete the repository's independent protected PR review and merge gate.",
          url: existing.rows[0].url,
        },
      ],
    };
  }
  const title = `release(paper): publish ${plan.publicationVersion} alpha`;
  const body = [
    "## Summary",
    "",
    `Promote \`${plan.source.ref}\` to \`${plan.target.ref}\` through the protected Buildchain paper release flow.`,
    "",
    "## Safety",
    "",
    "- Build and verification remain credential-free.",
    "- Exact artifact bytes are sealed before npm OIDC is available.",
    "- This PR does not bypass review or publish directly.",
  ].join("\n");
  const created = commandResult(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      plan.repository,
      "--base",
      plan.target.ref,
      "--head",
      plan.source.ref,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: plan.cwd },
  );
  if (!created.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      errorCode: created.error ? "gh-unavailable" : "github-pr-create-failed",
    };
  }
  const url =
    created.stdout
      .split(/\s+/)
      .find((entry) => /^https:\/\/github\.com\//.test(entry)) || "";
  return {
    ...plan,
    ok: true,
    dryRun: false,
    reused: false,
    pr: {
      url,
      headRefName: plan.source.ref,
      baseRefName: plan.target.ref,
    },
    nextActions: [
      {
        id: "review-alpha-pr",
        command: "",
        description:
          "Complete the repository's independent protected PR review and merge gate.",
        url,
      },
    ],
  };
}

function executeResumePlan(plan, buildchainRef) {
  if (!plan.resumable || !plan.transaction?.targetRef) {
    return {
      ...plan,
      dryRun: false,
      dispatched: false,
    };
  }
  const args = [
    "workflow",
    "run",
    ".github/workflows/paper-release.yml",
    "--ref",
    plan.transaction.targetRef,
  ];
  if (buildchainRef) {
    args.push("-f", `buildchain-ref=${buildchainRef}`);
  }
  const dispatched = commandResult("gh", args, { cwd: plan.cwd });
  if (!dispatched.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      dispatched: false,
      errorCode: dispatched.error
        ? "gh-unavailable"
        : "github-workflow-dispatch-failed",
    };
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    dispatched: true,
    nextActions: [
      {
        id: "inspect-resumed-transaction",
        command: "buildchain paper status --json",
        description:
          "Wait for the protected workflow, then inspect the same transaction coordinates.",
      },
    ],
  };
}

export async function runPaperCli(
  args = [],
  {
    buildchainRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
    buildchainVersion = "",
    buildchainRef = "v3",
    buildchainSha = "",
  } = {},
) {
  const [command = "", maybeSubcommand = "", ...rest] = args;
  const json = hasFlag(args, "json");
  try {
    if (!command || ["help", "--help", "-h"].includes(command)) {
      process.stdout.write(usage());
      return;
    }
    const effectiveArgs = maybeSubcommand.startsWith("--")
      ? [maybeSubcommand, ...rest]
      : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    let result;
    if (command === "scaffold") {
      const plan = planPaperScaffold({
        cwd,
        buildchainRoot,
        buildchainVersion,
        buildchainRef: readFlag(effectiveArgs, "buildchain-ref", buildchainRef),
        buildchainSha,
        name: readFlag(effectiveArgs, "name", path.basename(cwd)),
        title: readFlag(effectiveArgs, "title", ""),
        packageName: readFlag(effectiveArgs, "package", ""),
        repository: readFlag(effectiveArgs, "repository", ""),
        version: readFlag(effectiveArgs, "version", "0.1.0-alpha.0"),
        siteBaseUrl: readFlag(effectiveArgs, "site-base-url", ""),
      });
      result =
        hasFlag(effectiveArgs, "write") || hasFlag(effectiveArgs, "execute")
          ? writePaperScaffold(plan)
          : publicScaffoldPlan(plan);
    } else if (command === "migrate") {
      const plan = planPaperMigration({
        cwd,
        buildchainRoot,
        buildchainVersion,
        buildchainSha,
      });
      result =
        hasFlag(effectiveArgs, "write") || hasFlag(effectiveArgs, "execute")
          ? writePaperMigration(plan)
          : plan;
    } else if (command === "preflight") {
      result = collectPaperPreflight({
        cwd,
        buildchainRoot,
        buildchainVersion,
        buildchainRef: readFlag(effectiveArgs, "buildchain-ref", buildchainRef),
        buildchainSha,
        registry: readFlag(
          effectiveArgs,
          "registry",
          "https://registry.npmjs.org/",
        ),
        offline: hasFlag(effectiveArgs, "offline"),
      });
    } else if (command === "status") {
      result = collectPaperStatus({ cwd });
    } else if (command === "bootstrap" && maybeSubcommand === "npm") {
      result = executePaperNpmBootstrap({
        cwd,
        packageName: readFlag(effectiveArgs, "package", ""),
        bootstrapVersion: readFlag(
          effectiveArgs,
          "bootstrap-version",
          "0.0.0-bootstrap.0",
        ),
        registry: readFlag(
          effectiveArgs,
          "registry",
          "https://registry.npmjs.org/",
        ),
        repository: readFlag(effectiveArgs, "repository", ""),
        workflow: readFlag(effectiveArgs, "workflow", "paper-release.yml"),
        environment: readFlag(effectiveArgs, "environment", ""),
        execute: hasFlag(effectiveArgs, "execute"),
        confirmedPackage: readFlag(effectiveArgs, "confirm-public-package", ""),
        userconfig: readFlag(effectiveArgs, "userconfig", ""),
        offline: hasFlag(effectiveArgs, "offline"),
      });
    } else if (command === "build") {
      const plan = createPaperBuildPlan({
        cwd,
        sourceSha: readFlag(effectiveArgs, "source-sha", ""),
        pullToolchain: !hasFlag(effectiveArgs, "no-toolchain-pull"),
      });
      if (!hasFlag(effectiveArgs, "execute")) {
        result = plan;
      } else {
        const receipt = verifyPublicationReproducibility({
          cwd,
          sourceSha: plan.sourceSha,
          promote: true,
          keepWorkspaces: hasFlag(effectiveArgs, "keep-workspaces"),
          pullToolchain: plan.pullToolchain,
          packageName: readFlag(effectiveArgs, "package", ""),
        });
        result = {
          ...plan,
          ok: receipt.qualifying === true,
          dryRun: false,
          receipt,
          nextActions: receipt.qualifying
            ? [
                {
                  id: "paper-status",
                  command: "buildchain paper status --json",
                  description:
                    "Inspect the qualifying reproducibility evidence and remaining publication gates.",
                },
              ]
            : [
                {
                  id: "repair-reproducibility",
                  command:
                    "buildchain paper build --execute --keep-workspaces --json",
                  description:
                    "Retain both clean workspaces and inspect the first byte difference.",
                },
              ],
        };
      }
    } else if (command === "alpha") {
      const plan = createPaperAlphaPlan({
        cwd,
        sourceRef: readFlag(effectiveArgs, "source-ref", ""),
        targetRef: readFlag(effectiveArgs, "target-ref", ""),
      });
      result = hasFlag(effectiveArgs, "execute")
        ? executeAlphaPlan(plan)
        : plan;
    } else if (command === "resume") {
      const runtimeRef = readFlag(effectiveArgs, "buildchain-ref", "");
      const plan = createPaperResumePlan({
        cwd,
        buildchainRef: runtimeRef,
      });
      result = hasFlag(effectiveArgs, "execute")
        ? executeResumePlan(plan, runtimeRef)
        : plan;
    } else {
      throw new Error(
        "usage: buildchain paper <scaffold|migrate|preflight|bootstrap npm|build|alpha|status|resume> ...",
      );
    }
    printResult(result, json);
    if (result.ok === false) {
      process.exitCode = 1;
    }
    return result;
  } catch (error) {
    if (!json) throw error;
    const failure = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-paper-error",
      ok: false,
      error: {
        code: error.code || "paper-command-failed",
        message: error.message,
      },
      nextActions: [],
    };
    printJson(failure);
    process.exitCode = 1;
    return failure;
  }
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      ),
      "utf8",
    ),
  );
  runPaperCli(process.argv.slice(2), {
    buildchainRoot: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
    buildchainVersion: packageJson.version,
  }).catch((error) => {
    console.error(`paper: ${error.message}`);
    process.exitCode = 1;
  });
}
