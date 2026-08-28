import fs from "node:fs";
import path from "node:path";
import {
  gitResult,
  gitValue,
  normalizeRepository,
  sha256Text,
} from "./paper-repository.js";
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function texEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\textbackslash{}")
    .replaceAll("&", "\\&")
    .replaceAll("%", "\\%")
    .replaceAll("$", "\\$")
    .replaceAll("#", "\\#")
    .replaceAll("_", "\\_")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}");
}

export function scaffoldMakefile({ image, digest, command }) {
  return `.PHONY: check pdf clean

BUILDER_IMAGE := ${image}@${digest}
SOURCE_DATE_EPOCH ?= 0

check:
\t@test -f paper/main.tex
\t@test -f paper/references.bib
\t@git diff --check

pdf:
\t@mkdir -p _build
\tdocker run --rm --network=none \\
\t\t-e SOURCE_DATE_EPOCH="$(SOURCE_DATE_EPOCH)" \\
\t\t-e TZ=UTC -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 -e HOME=/tmp \\
\t\t-v "$(CURDIR):/workspace" -w /workspace \\
\t\t"$(BUILDER_IMAGE)" bash -lc '${command}'

clean:
\trm -rf _build
`;
}

export function paperPackageScripts(current = {}) {
  return {
    ...current,
    "buildchain:paper": "buildchain paper",
    "paper:preflight": "buildchain paper preflight --json",
    "paper:agent:verify": "buildchain paper agent verify --json",
    "paper:work:start": "buildchain paper work start",
    "paper:work:submit": "buildchain paper work submit",
    "paper:status": "buildchain paper status --json",
  };
}

export function managedPaperPackageJson(current, buildchainVersion) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildchainVersion)) {
    throw new Error(
      "paper repositories require an exact Buildchain semantic version",
    );
  }
  const packageManager = current.packageManager || "pnpm@11.7.0";
  if (!packageManager.startsWith("pnpm@")) {
    throw new Error("paper repositories require a pnpm packageManager");
  }
  return {
    ...current,
    private: true,
    scripts: paperPackageScripts(current.scripts),
    devDependencies: {
      ...(current.devDependencies || {}),
      "@kungfu-tech/buildchain": buildchainVersion,
    },
    packageManager,
  };
}

export function scaffoldPackageJson({
  name,
  packageName,
  repository,
  buildchainVersion,
}) {
  return jsonText({
    ...managedPaperPackageJson(
      {
        name: packageName,
        description: `${name} publication source repository.`,
        repository: {
          type: "git",
          url: `git+https://github.com/${repository}.git`,
        },
        license: "Apache-2.0",
      },
      buildchainVersion,
    ),
  });
}

export function scaffoldReadme({ title, packageName }) {
  return `# ${title}

This repository is a Buildchain-governed publication artifact source.

## Local workflow

\`\`\`sh
pnpm paper:preflight
pnpm paper:agent:verify
pnpm paper:work:start -- <topic>
pnpm paper:work:submit
make pdf
\`\`\`

The public package identity is \`${packageName}\`. Buildchain owns reproducible
artifact generation, sealed publication, npm Trusted Publishing, and recovery;
this repository owns the paper source and review history.

See [docs/MAP.md](docs/MAP.md) for the repository map.
`;
}

export function scaffoldMap() {
  return `# Repository Map

- \`paper/main.tex\`: paper source entrypoint.
- \`paper/references.bib\`: bibliography source.
- \`AGENTS.md\`: mandatory managed entry instructions for people and coding agents.
- \`.buildchain/paper/agent-entry.json\`: versioned, digest-bound local and CI entry policy.
- \`.buildchain/buildchain.toml\`: publication identity, toolchain, package, and lifecycle contract.
- \`.buildchain/contract-lock.json\`: accepted Buildchain runtime contract.
- \`.github/workflows/build.yml\`: thin read-only build and reproducibility caller.
- \`.github/workflows/verify.yml\`: thin required check that enforces the Paper entry and acceptance policy.
- \`.github/workflows/paper-release.yml\`: thin protected sealed-release caller.

The repository does not own npm transaction logic, publication authority,
release-state recovery, or site deployment mechanics. Those remain Buildchain,
npm/GitHub, and downstream site responsibilities respectively.
`;
}

export function scaffoldMainTex(title) {
  return `\\documentclass[11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{hyperref}

\\title{${texEscape(title)}}
\\author{}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
Replace this paragraph with the paper abstract.
\\end{abstract}

\\section{Introduction}
Replace this section with the reviewed paper content.

\\bibliographystyle{plain}
\\bibliography{paper/references}
\\end{document}
`;
}
function planPaperScaffold(
  runtime,
  {
    cwd = process.cwd(),
    buildchainRoot = process.cwd(),
    buildchainVersion = "",
    buildchainRef = "v3",
    buildchainSha = "",
    name = path.basename(path.resolve(cwd)),
    title = "",
    packageName = "",
    repository = "",
    version = "0.1.0-alpha.0",
    siteBaseUrl = "",
  } = {},
) {
  const resolvedCwd = path.resolve(cwd);
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("paper scaffold requires --name");
  const normalizedPackage = runtime.normalizePackageName(packageName);
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    throw new Error("paper scaffold requires --repository <owner/repo>");
  }
  const normalizedVersion = String(version || "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error("paper scaffold --version must be semver");
  }
  const runtimeIdentity = runtime.buildchainPackageIdentity(
    buildchainRoot,
    buildchainVersion,
  );
  const runtimeSha =
    buildchainSha ||
    runtime.resolvePaperRuntimeGitSha(buildchainRoot, runtimeIdentity.version);
  if (!runtime.GIT_SHA_PATTERN.test(runtimeSha)) {
    throw new Error(
      "paper scaffold cannot resolve the exact Buildchain runtime SHA; pass buildchainSha or use a published Buildchain package with npm gitHead provenance",
    );
  }
  const files = runtime.scaffoldFiles({
    buildchainRoot,
    buildchainVersion: runtimeIdentity.version,
    buildchainRef,
    buildchainSha: runtimeSha,
    cwd: resolvedCwd,
    name: normalizedName,
    title: title || normalizedName,
    packageName: normalizedPackage,
    repository: normalizedRepository,
    version: normalizedVersion,
    siteBaseUrl,
  });
  const changes = [...files.entries()].map(([relativePath, content]) => {
    const filePath = path.resolve(resolvedCwd, relativePath);
    const exists = fs.existsSync(filePath);
    if (!exists) {
      return {
        path: relativePath,
        action: "create",
        sha256: sha256Text(content),
        content,
      };
    }
    if (!fs.statSync(filePath).isFile()) {
      return {
        path: relativePath,
        action: "conflict",
        reason: "path-exists-and-is-not-a-file",
        sha256: sha256Text(content),
        content,
      };
    }
    const current = fs.readFileSync(filePath, "utf8");
    return current === content
      ? {
          path: relativePath,
          action: "unchanged",
          sha256: sha256Text(content),
          content,
        }
      : {
          path: relativePath,
          action: "conflict",
          reason: "existing-content-differs",
          currentSha256: sha256Text(current),
          sha256: sha256Text(content),
          content,
        };
  });
  const publicChanges = changes.map(({ content: _content, ...entry }) => entry);
  const conflicts = publicChanges.filter(
    (entry) => entry.action === "conflict",
  );
  const result = {
    schemaVersion: 1,
    contract: runtime.PAPER_SCAFFOLD_CONTRACT,
    ok: conflicts.length === 0,
    cwd: resolvedCwd,
    dryRun: true,
    identity: {
      project: normalizedName,
      title: title || normalizedName,
      package: normalizedPackage,
      repository: normalizedRepository,
      version: normalizedVersion,
    },
    buildchain: {
      version: runtimeIdentity.version,
      ref: runtimeSha,
      resolvedSha: runtimeSha,
    },
    summary: {
      create: publicChanges.filter((entry) => entry.action === "create").length,
      unchanged: publicChanges.filter((entry) => entry.action === "unchanged")
        .length,
      conflict: conflicts.length,
    },
    changes: publicChanges,
    conflicts,
    nextActions:
      conflicts.length > 0
        ? [
            {
              id: "resolve-scaffold-conflicts",
              command: "",
              description:
                "Resolve the listed semantic conflicts; scaffold never overwrites them.",
            },
          ]
        : [
            {
              id: "write-scaffold",
              command: "buildchain paper scaffold --write <same arguments>",
              description:
                "Write only missing files after the conflict-free plan is reviewed.",
            },
          ],
  };
  Object.defineProperty(result, "_plannedFiles", {
    value: changes,
    enumerable: false,
  });
  return result;
}

function writePaperScaffold(runtime, plan) {
  if (!plan || plan.contract !== runtime.PAPER_SCAFFOLD_CONTRACT) {
    throw new Error("paper scaffold plan contract mismatch");
  }
  if (!plan.ok || plan.conflicts.length > 0) {
    return {
      ...plan,
      dryRun: false,
      written: [],
      ok: false,
      errorCode: "paper-scaffold-conflict",
    };
  }
  const resolvedCwd = path.resolve(plan.cwd);
  const creates = plan._plannedFiles.filter(
    (entry) => entry.action === "create",
  );
  for (const entry of creates) {
    const target = path.resolve(resolvedCwd, entry.path);
    if (fs.existsSync(target)) {
      const current = fs.statSync(target).isFile()
        ? fs.readFileSync(target, "utf8")
        : undefined;
      if (current !== entry.content) {
        throw new Error(
          `paper scaffold race detected at ${entry.path}; no file was overwritten`,
        );
      }
      continue;
    }
  }
  const written = [];
  for (const entry of creates) {
    const target = path.resolve(resolvedCwd, entry.path);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, { flag: "wx" });
    written.push(entry.path);
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    written,
    idempotent: written.length === 0,
    nextActions: [
      {
        id: "paper-preflight",
        command: `buildchain paper preflight --cwd ${JSON.stringify(resolvedCwd)} --json`,
        description:
          "Verify the generated repository before any external mutation.",
      },
    ],
  };
}

function planPaperMigration(
  runtime,
  {
    cwd = process.cwd(),
    buildchainRoot = process.cwd(),
    buildchainVersion = "",
    buildchainSha = "",
  } = {},
) {
  const resolvedCwd = path.resolve(cwd);
  const repositoryRoot = gitValue(resolvedCwd, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const repositoryPrefix = gitValue(resolvedCwd, [
    "rev-parse",
    "--show-prefix",
  ]).replace(/\/+$/u, "");
  if (!repositoryRoot || repositoryPrefix) {
    throw new Error("paper migration must target the exact repository root");
  }
  const source = {
    head: gitValue(resolvedCwd, ["rev-parse", "HEAD"]),
    clean: gitResult(resolvedCwd, ["status", "--porcelain"]).stdout === "",
  };
  if (!runtime.GIT_SHA_PATTERN.test(source.head)) {
    throw new Error("paper migration requires a committed Git source");
  }
  const plannedFiles = [
    ...runtime.migrationFiles({
      cwd: resolvedCwd,
      buildchainRoot,
      buildchainVersion,
      buildchainSha,
    }),
  ].map(([relativePath, content]) => {
    const target = path.resolve(resolvedCwd, relativePath);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      return {
        path: relativePath,
        action: "conflict",
        currentSha256: "",
        sha256: sha256Text(content),
        content,
      };
    }
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : undefined;
    return {
      path: relativePath,
      action:
        current === undefined
          ? "create"
          : current === content
            ? "unchanged"
            : "update",
      currentSha256: current === undefined ? "" : sha256Text(current),
      sha256: sha256Text(content),
      content,
    };
  });
  const changes = plannedFiles.map(({ content: _content, ...entry }) => entry);
  const conflicts = changes.filter((entry) => entry.action === "conflict");
  const ok = source.clean && conflicts.length === 0;
  const result = {
    schemaVersion: 1,
    contract: runtime.PAPER_MIGRATION_CONTRACT,
    ok,
    cwd: resolvedCwd,
    dryRun: true,
    source,
    summary: {
      create: changes.filter((entry) => entry.action === "create").length,
      update: changes.filter((entry) => entry.action === "update").length,
      unchanged: changes.filter((entry) => entry.action === "unchanged").length,
      conflict: conflicts.length,
    },
    changes,
    conflicts,
    nextActions: !source.clean
      ? [
          {
            id: "commit-source",
            command: "git status --short",
            description:
              "Migration only rewrites Buildchain-owned control files from a clean committed source.",
          },
        ]
      : conflicts.length > 0
        ? [
            {
              id: "resolve-migration-conflicts",
              command: "",
              description:
                "Resolve non-file targets; migration never replaces a directory or special path.",
            },
          ]
        : [
            {
              id: "write-migration",
              command: "buildchain paper migrate --write --json",
              description:
                "Write the reviewed Buildchain-owned control files without changing paper content or publication configuration.",
            },
            {
              id: "refresh-pnpm-lock",
              command: "pnpm install --lockfile-only",
              description:
                "Bind the exact Buildchain semantic dependency into pnpm-lock.yaml after the reviewed package update.",
            },
          ],
  };
  Object.defineProperty(result, "_plannedFiles", {
    value: plannedFiles,
    enumerable: false,
  });
  return result;
}

function writePaperMigration(runtime, plan) {
  if (!plan || plan.contract !== runtime.PAPER_MIGRATION_CONTRACT) {
    throw new Error("paper migration plan contract mismatch");
  }
  if (!plan.ok) {
    return {
      ...plan,
      dryRun: false,
      written: [],
      updated: [],
      ok: false,
      errorCode: "paper-migration-blocked",
    };
  }
  const written = [];
  const updated = [];
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    const exists = fs.existsSync(target);
    const current =
      exists && fs.statSync(target).isFile()
        ? fs.readFileSync(target, "utf8")
        : undefined;
    const currentSha256 = current === undefined ? "" : sha256Text(current);
    if (
      (entry.action === "create" && exists) ||
      (entry.action === "update" && currentSha256 !== entry.currentSha256)
    ) {
      throw new Error(
        `paper migration race detected at ${entry.path}; no stale plan was applied`,
      );
    }
  }
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, {
      flag: entry.action === "create" ? "wx" : "w",
    });
    (entry.action === "create" ? written : updated).push(entry.path);
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    written,
    updated,
    idempotent: written.length === 0 && updated.length === 0,
    nextActions: [
      {
        id: "paper-preflight",
        command: `buildchain paper preflight --cwd ${JSON.stringify(plan.cwd)} --offline --json`,
        description:
          "Verify the migrated repository before any external mutation.",
      },
    ],
  };
}

export function createPaperScaffoldOperations(runtime) {
  return {
    planPaperMigration: (options) => planPaperMigration(runtime, options),
    planPaperScaffold: (options) => planPaperScaffold(runtime, options),
    writePaperMigration: (plan) => writePaperMigration(runtime, plan),
    writePaperScaffold: (plan) => writePaperScaffold(runtime, plan),
  };
}
