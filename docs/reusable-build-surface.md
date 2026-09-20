---
status: active
period: ongoing
theme: buildchain-reusable-build
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Shared caller generator, schema-2 product plan, pipeline build node and internal signing workflow.
  invisible_context_boundary: Local source inspection does not establish hosted release qualification or provider authorization.
---

# Consumer build and verification

A repository declares products in `.buildchain/buildchain.toml`. The shared
`buildchain.yml` caller invokes `public-ops-pipeline.yml@v4`; the shared
`buildchain-recover.yml` caller invokes `public-ops-recover.yml@v4`.
Use [init](getting-started.md) to generate both callers. Their bytes are the same
for npm packages, binary archives and Paper PDFs.

## Product commands

Each schema-2 `[[products]]` entry declares its product type, supported platforms,
install/build/verify commands, artifacts and publication targets. For example:

```toml
schema = 2

[[products]]
id = "library"
type = "npm"
platforms = ["linux-x64"]
install = ["corepack pnpm install --frozen-lockfile"]
build = ["corepack pnpm run build"]
verify = ["corepack pnpm run check"]

[[products.artifacts]]
id = "package"
path = "."
kind = "npm-package"

[[products.targets]]
provider = "npm"
access = "public"
artifacts = ["package"]
```

This excerpt describes a product. The complete configuration also declares version
sources, protected channel routes and review policy; use the
[complete standard examples](../templates/minimal-consumer/) for those sections.

The runtime executes install, build and verify in order for each selected product.
Commands run in the product directory inside the admitted checkout. They receive
an environment without provider credentials, and their output cannot become a
privileged action's authority output. Runner environment/path file commands can
carry product toolchain settings between phases.

Build source verification binds the exact Git commit, tree and TOML blob, and
checks tracked file bytes and modes before and after execution. A failed product
command or source change fails that observation. Successful product execution is
an input to the runtime's independent qualification and publication stages.

## Runtime selection and recovery

Caller source selects `v4` or `v4-alpha`. A tool-maintained contract lock, when
present, selects its qualified runtime. Without a lock, the entry selects its own
exact runtime commit. Source-persisted train or SHA overrides are not consumer
configuration.

For an interrupted operation, select its exact attempt in `buildchain-recover.yml`.
An optional repaired runtime belongs to that recovery request. Source, artifacts,
provider effects and prior receipts remain bound to the original attempt. See
[the Golden Path](getting-started.md) for the normal protected PR flow.

## Internal implementation boundaries

The [workflow catalog](workflow-catalog.md) identifies internal components.
Consumers do not call their workflows/actions or supply material roots, provider
payloads, Warrant state or direct artifact-download handoffs.

The internal `.release-signing-authority.yml` owns native signing credentials and
provider verification. Its protected `buildchain-artifact-signing` environment
retains certificate/notary inputs; the credential job never checks out or executes
consumer source. Ordinary artifact jobs receive no certificate or notary secrets.
The signing adapters verify returned bytes and provider results before delivery.
These implementation contracts do not add another consumer entry or imply that
all internal product capabilities are schema-2 configuration options.

Maintainers changing product execution or credential boundaries must update the
plan, implementation, source-bound tests, generated references and site bundle,
and run the full repository check. Retained schema-1 build fixtures exercise
internal implementation history; they are not current consumer templates.
