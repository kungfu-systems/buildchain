---
status: active
period: ongoing
theme: buildchain-golden-path
doc_type: technical-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-01
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-01
  invisible_context: not asserted
---

# Buildchain Golden Path

This path is for a repository maintainer adopting Buildchain for the first
time. It takes about 15–30 minutes and ends with five inspectable outcomes: an
exact package pin, a declared project type, a valid local configuration, a thin
reusable workflow caller, and a Release Passport inspection.

Use this page for the first successful pass. Move to the advanced manuals only
after the local checks below are green.

## 1. Create a clean consumer and install an exact version

```bash
consumer_dir="$(mktemp -d)"
cd "$consumer_dir"
npm init -y
buildchain_version="$(npm view @kungfu-tech/buildchain version)"
pnpm add -D "@kungfu-tech/buildchain@$buildchain_version"
pnpm exec buildchain --version
```

The package manager records the exact resolved version in `package.json` and
the lockfile. Review that version before committing it; do not leave a floating
range in a release repository.

## 2. Choose the project type and initialize

Start with `package` for a Node package. Other supported types are `native`,
`web-surface`, `infra-contract`, `publication-artifact`, and
`anchored-package`.

```bash
pnpm exec buildchain init --type package --package-manager pnpm
```

Inspect the two generated files before continuing:

```bash
sed -n '1,220p' .buildchain/buildchain.toml
sed -n '1,220p' .github/workflows/build.yml
```

`buildchain.toml` owns repository lifecycle declarations. The workflow is a
thin caller of Buildchain's reusable workflow; it is not a second release
implementation.

## 3. Validate the local contract

```bash
pnpm exec buildchain validate \
  --require-version-state \
  --require-lifecycle-stages install,build,verify
pnpm exec buildchain doctor --json
```

If the generated lifecycle commands do not match the repository, edit only
`.buildchain/buildchain.toml`, then rerun both checks. See
[Lifecycle Protocol](lifecycle-protocol.md) for the normative fields.

## 4. Inspect the reusable workflow and release dry-run

The generated caller should contain one reusable `uses:` edge and a manual
`buildchain-ref` input for bounded train validation:

```bash
rg -n 'uses:|buildchain-ref:' .github/workflows/build.yml
pnpm exec buildchain release --dry-run \
  --target-ref alpha/v4/v4.0 \
  --json
```

The dry-run explains legal source refs, tags, version state, and publication
effects. It does not move refs, edit files, or publish packages.

## 5. Create and inspect a local Release Passport example

This example creates a source-bound local Passport through the public Node API,
then reads it through the CLI. It is learning evidence, not publication
authority.

```bash
mkdir -p .buildchain/golden-path
node --input-type=module <<'EOF'
import fs from "node:fs";
import { createReleasePassport } from "@kungfu-tech/buildchain";

const passport = createReleasePassport({
  repository: "example/consumer",
  tag: "v0.1.0-alpha.0",
  sourceSha: "a".repeat(40),
  assets: [{ name: "consumer.tgz", sha256: "b".repeat(64) }],
});
fs.writeFileSync(
  ".buildchain/golden-path/buildchain.release.json",
  `${JSON.stringify(passport, null, 2)}\n`,
);
EOF

pnpm exec buildchain inspect release \
  --passport .buildchain/golden-path/buildchain.release.json \
  --json
```

For a real release, the protected Buildchain workflow creates the Passport from
the exact source, artifact, controller, and publication evidence. See
[Release Passport](release-passport.md); do not promote this local example.

## You are done when

- the dependency and lockfile contain one exact Buildchain version;
- `.buildchain/buildchain.toml` declares the intended project type and lifecycle;
- `validate` and `doctor` succeed;
- `.github/workflows/build.yml` remains a thin reusable-workflow caller;
- the release dry-run and local Passport inspection both return structured output.

The repository test `pnpm run check:golden-path` reproduces this path in a new
temporary consumer using the locally packed Buildchain package.

## Choose the next manual

| Intent | Next page |
| --- | --- |
| Change lifecycle commands or version files | [Lifecycle Protocol](lifecycle-protocol.md) |
| Configure native matrices, runners, caches, or artifacts | [Reusable Build Surface](reusable-build-surface.md) |
| Look up a command | [Generated CLI Reference](cli-reference.md) |
| Import the Node toolkit | [Generated Node API Reference](node-api-reference.md) |
| Understand protected branches and tags | [Release Flow](release-flow.md) |
| Verify published evidence | [Release Passport](release-passport.md) |

## Troubleshooting

- `already exists`: initialization is no-overwrite by default. Inspect the
  existing files; use `--force` only for an intentional replacement.
- missing lifecycle stage: add the named stage to
  `.buildchain/buildchain.toml`; do not weaken the validation command.
- package release-age policy: add a temporary, package-and-version-specific
  `minimumReleaseAgeExclude`, then remove it after the normal window.
- unsure about syntax: run `buildchain <path> --help`. Help is intercepted
  before command dispatch and is side-effect free at every governed path.

## Small glossary

- **project type**: the repository shape selected by `buildchain init`.
- **lifecycle**: repository-owned install, build, verify, and publish commands.
- **reusable workflow**: Buildchain-owned GitHub Actions control plane called by
  a thin consumer workflow.
- **Release Passport**: source- and artifact-bound release evidence, not a
  release trigger.
- **train ref**: a temporary validation runtime; never a production dependency.
