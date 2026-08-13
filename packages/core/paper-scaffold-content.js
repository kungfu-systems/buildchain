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
