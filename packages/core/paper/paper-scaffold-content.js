import {
  applyPaperMigration,
  paperFileTarget as scaffoldTarget,
} from "./operations/migration.js";
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

export function scaffoldPackageJson({
  name,
  title,
  packageName,
  repository,
  version,
  siteBaseUrl,
  buildchainVersion,
}) {
  return jsonText({
    name: packageName,
    version,
    private: true,
    description: title || `${name} publication source repository.`,
    repository: {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
    },
    ...(siteBaseUrl ? { homepage: siteBaseUrl } : {}),
    license: "Apache-2.0",
    scripts: { build: "make pdf", check: "make check" },
    devDependencies: { "@kungfu-tech/buildchain": buildchainVersion },
    packageManager: "pnpm@11.7.0",
  });
}

function paperDocument(body) {
  return `---
status: draft
period: ongoing
theme: paper-consumer
doc_type: implementation-guide
source_level: generated-template
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Shared schema-2 Paper source scaffold and caller templates.
  invisible_context_boundary: No hosted build or publication is claimed.
---

${body}`;
}

export function scaffoldReadme({ title }) {
  return paperDocument(`# ${title}

This repository owns the paper source, product build commands and review history.

## Local workflow

\`\`\`sh
make pdf
make check
buildchain validate --require-lifecycle-stages build,verify
\`\`\`

Open a protected channel PR to request delivery or publication. The published
Buildchain pipeline builds and publishes the PDF to GitHub Releases. The same
normal and recovery callers serve npm, binary and Paper products. Recovery takes
an exact attempt, with an optional temporary repaired runtime.

The private package.json identifies this source repository and its version;
it is not an npm publication target.

See [docs/MAP.md](docs/MAP.md) for the repository map.
`);
}

export function scaffoldMap() {
  return paperDocument(`# Repository Map

- \`paper/main.tex\`: paper source entrypoint.
- \`paper/references.bib\`: bibliography source.
- \`Makefile\`: product PDF build and verification commands.
- \`package.json\`: source identity, title, version and optional homepage.
- \`AGENTS.md\`: shared consumer instructions.
- \`.buildchain/buildchain.toml\`: schema-2 product and channel policy.
- \`.github/workflows/buildchain.yml\`: shared normal caller.
- \`.github/workflows/buildchain-recover.yml\`: shared exact-attempt recovery caller.

Tool-maintained contract locks bind the published runtime. Publication,
provider readback and release recovery belong to that runtime.
`);
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
function scaffoldRoot(cwd) {
  let existing = path.resolve(cwd);
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing)
      throw new Error("Cannot resolve Paper scaffold parent");
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory())
    throw new Error("Paper scaffold root must be a directory");
  return path.join(fs.realpathSync(existing), ...missing);
}

function additionalScaffoldWorkflows(cwd, paths) {
  const directory = path.join(cwd, ".github/workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isFile() ||
        (/\.ya?ml$/iu.test(entry.name) &&
          !paths.includes(`.github/workflows/${entry.name}`)),
    )
    .map((entry) => ({
      path: `.github/workflows/${entry.name}`,
      action: "conflict",
      reason: "outside-shared-consumer-pair",
    }));
}

function planPaperScaffold(
  runtime,
  {
    cwd = process.cwd(),
    buildchainRoot = process.cwd(),
    buildchainVersion = "",
    buildchainRef = "v4",
    name = path.basename(path.resolve(cwd)),
    title = "",
    packageName = "",
    repository = "",
    version = "0.1.0-alpha.0",
    siteBaseUrl = "",
  } = {},
) {
  const resolvedCwd = scaffoldRoot(cwd);
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("paper scaffold requires --name");
  const normalizedPackage = runtime.normalizePackageName(
    packageName || normalizedName,
  );
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
  if (buildchainRef !== "v4")
    throw new Error(
      "Paper scaffold uses the shared published v4 caller; exact runtimes belong in tool-maintained locks",
    );
  const files = runtime.scaffoldFiles({
    buildchainRoot,
    buildchainVersion: runtimeIdentity.version,
    buildchainRef,
    cwd: resolvedCwd,
    name: normalizedName,
    title: title || normalizedName,
    packageName: normalizedPackage,
    repository: normalizedRepository,
    version: normalizedVersion,
    siteBaseUrl,
  });
  const changes = [...files.entries()].map(([relativePath, content]) => {
    const filePath = scaffoldTarget(resolvedCwd, relativePath);
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
  changes.push(...additionalScaffoldWorkflows(resolvedCwd, [...files.keys()]));
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
      ref: "v4",
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
  if (
    fs.lstatSync(resolvedCwd, { throwIfNoEntry: false })?.isSymbolicLink() ||
    scaffoldRoot(resolvedCwd) !== resolvedCwd
  )
    throw new Error("Paper scaffold root changed after planning");
  const creates = plan._plannedFiles.filter(
    (entry) => entry.action === "create",
  );
  for (const entry of plan._plannedFiles) {
    const target = scaffoldTarget(resolvedCwd, entry.path);
    if (entry.action === "unchanged" && !fs.existsSync(target))
      throw new Error(`paper scaffold race detected at ${entry.path}`);
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
  if (
    additionalScaffoldWorkflows(
      resolvedCwd,
      plan._plannedFiles.map((entry) => entry.path),
    ).length
  )
    throw new Error("paper scaffold workflow inventory changed after planning");
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
        id: "consumer-validate",
        command: `buildchain validate --cwd ${JSON.stringify(resolvedCwd)} --require-lifecycle-stages build,verify`,
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
    stableBuildchainRoot = "",
    alphaBuildchainRoot = "",
  } = {},
) {
  if (stableBuildchainRoot || alphaBuildchainRoot)
    throw new Error(
      "Paper migration rejects retired channel-root inputs; runtime locks are preserved by the shared setup contract",
    );
  const resolvedCwd = fs.realpathSync(cwd);
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
  for (const relative of [
    ".buildchain/buildchain.toml",
    "package.json",
    "AGENTS.md",
    "pnpm-workspace.yaml",
    ".github/workflows/buildchain.yml",
    ".github/workflows/buildchain-recover.yml",
  ])
    scaffoldTarget(resolvedCwd, relative);
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
      stableBuildchainRoot,
      alphaBuildchainRoot,
    }),
  ].map(([relativePath, content]) => {
    const target = path.resolve(resolvedCwd, relativePath);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      return {
        path: relativePath,
        action: "conflict",
        currentSha256: "",
        sha256: content === null ? "" : sha256Text(content),
        content,
      };
    }
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : undefined;
    return {
      path: relativePath,
      action:
        content === null
          ? current === undefined
            ? "unchanged"
            : "remove"
          : current === undefined
            ? "create"
            : current === content
              ? "unchanged"
              : "update",
      currentSha256: current === undefined ? "" : sha256Text(current),
      sha256: content === null ? "" : sha256Text(content),
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
      remove: changes.filter((entry) => entry.action === "remove").length,
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
                "Convert product configuration to the shared pipeline and retire the listed verified legacy control files; source content and historical receipts remain untouched.",
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

export function createPaperScaffoldOperations(runtime) {
  return {
    planPaperMigration: (options) => planPaperMigration(runtime, options),
    planPaperScaffold: (options) => planPaperScaffold(runtime, options),
    writePaperMigration: applyPaperMigration,
    writePaperScaffold: (plan) => writePaperScaffold(runtime, plan),
  };
}
