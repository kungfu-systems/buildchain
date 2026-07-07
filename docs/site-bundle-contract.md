# Site Bundle Contract

`@kungfu-tech/buildchain` publishes `dist/site/` as the package-owned fact
source for `buildchain.libkungfu.dev` and other documentation surfaces.

The website may design navigation, visual hierarchy, examples, and explanatory
copy around these facts. It should not hand-write the current Buildchain
release mechanics, command registry, workflow registry, or artifact schema.

## Files

```text
dist/site/
  buildchain-site.json
  site-manifest.json
  cli-registry.json
  manual-registry.json
  node-api-registry.json
  workflow-registry.json
  release-model.json
  artifact-schemas.json
  buildchain-contract.json
  kfd-claims.json
  product-mechanism.json
  release-provenance.json
  agent-index.json
```

`buildchain-site.json` is the top-level bundle entrypoint.
It includes a `homepage` object generated from `README.md`, including
`homepage.sections`, `homepage.displayPlan`, and a
`homepage.rendererContract` that is implementation metadata rather than
ordinary homepage copy. Site repositories should consume those fields instead
of parsing `README.md` themselves.
It also includes a `pages` collection that mirrors `page-registry.json`, so a
site repository can build the full Buildchain public documentation surface from
the npm package without scanning the source checkout.
`page-registry.json` is the complete page fact source: README homepage content,
all packaged `docs/*.md` manuals, action README files, the Node API package
overview, and fixture guides.
`buildchain-contract.json` is the machine-readable Buildchain runtime contract
world used by floating-ref contract locks. It records public workflow/action/CLI
surfaces, compatibility digests, and audit digests for the files that implement
those surfaces.
`manual-registry.json` enumerates the packaged Markdown manuals with source
digests so an agent can find complete operating documentation from the npm
artifact. `node-api-registry.json` enumerates public Node import surfaces from
`package.json#exports`, so agents do not have to infer supported APIs from
internal paths.
`kfd-claims.json` is the Buildchain-owned KFD claim registry. It is generated
from `packages/core/buildchain-kfd-claims.js` and enumerates the public release
claims plus the KFD-3 collaboration surfaces that Buildchain self-verifies
during release promotion.

## Timestamp and Reproducibility Policy

Every Buildchain-owned surface manifest uses the same timestamp policy fields:

- `generatedAt`: when the manifest JSON was generated.
- `publishedAt`: when the surface was published, when known.
- `reproducible`: whether the manifest declares its reproducibility inputs.
- `timestampPolicy`: `ci-injected` for release/workflow-generated public
  artifacts, or `source-date-epoch` for local deterministic source checks.
- `deterministicInputs`: the source files, revisions, package metadata, and
  declared Buildchain contracts that determine the manifest bytes.
- `sourceDateEpoch` / `sourceRevision`: the deterministic time input or source
  revision used to reproduce the manifest.
- `timestampPolicyDetails.timestampFieldsParticipateInArtifactDigest`: whether
  timestamp fields are included in the artifact digest being audited.

The policy is defined by `@kungfu-tech/buildchain/surface-manifest` and applies
to the root site bundle, `site-manifest.json`, and web-surface deployment
manifests for named surfaces such as KFD, Buildchain, and Core. Site
repositories should render these fields; they should not invent their own
manifest time semantics.

Source checkouts may use `SOURCE_DATE_EPOCH` for deterministic local checks.
Published CI/release artifacts should inject real timestamps with
`BUILDCHAIN_SITE_GENERATED_AT` / `BUILDCHAIN_SITE_PUBLISHED_AT` or the matching
`BUILDCHAIN_SURFACE_*` variables, so public manifests do not expose epoch time
as if it were a real metadata time.

## npm Consumption

```bash
npm install @kungfu-tech/buildchain
```

Then read files from:

```text
node_modules/@kungfu-tech/buildchain/dist/site/
```

Package exports are also provided for direct JSON-aware consumers:

```js
import siteManifest from "@kungfu-tech/buildchain/site/site-manifest.json" with { type: "json" };
```

## Generation

```bash
pnpm run generate:site
pnpm run check:site
```

`check:site` fails when generated files are stale. `pnpm run check` includes
this gate, so release candidates cannot publish an out-of-date site bundle.

## Scope

The P0 bundle includes:

- README-derived homepage fields and display plan;
- complete markdown page registry for public Buildchain docs, action manuals,
  Node API overview, and fixtures;
- site manifest;
- CLI command registry;
- manual registry for packaged agent-facing documentation;
- Node API registry for public package exports;
- workflow/action registry;
- release model facts;
- artifact and evidence schema index;
- Buildchain runtime contract world for `@v2` floating-ref compatibility checks,
  KFD-1/KFD-2/KFD-3 release gates, GitHub Release evidence publication, and
  site-consumption contracts;
- Buildchain KFD claim registry for release-passport self verification and
  agent-first public claim discovery;
- product mechanism manifest;
- release provenance;
- agent read order.

Future minor lines can add examples, recipes, fixture indexes, and richer
schema metadata without breaking existing consumers.

`release-propagation.md` describes the package-to-package or package-to-site
release chain model. The site bundle exposes that document and the
`release-propagation` CLI entry so downstream sites can render the current
Buildchain-owned propagation contract instead of hand-writing it.

## Rendering Boundary

Buildchain owns the homepage wording, section ordering intent, complete
markdown page registry, release model facts, workflow/action registry, CLI
registry, manual registry, Node API registry, KFD claim registry, and
release-passport evidence vocabulary. The site owns HTML, CSS, responsive
layout, navigation, visual assets, decorative media, markdown-to-HTML rendering,
and progressive disclosure within the Buildchain-provided
`homepage.displayPlan` and page metadata.

The page registry is also part of Buildchain's KFD-3 collaboration-interface
surface. Releases declare it as a site-consumption contract, and Buildchain's
KFD-3 witness generation includes the underlying markdown sources as public
documentation surfaces. If a page is public enough for the site to render, it
must be declared and hash-bound in the package-owned site bundle.
