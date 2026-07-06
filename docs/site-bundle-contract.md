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
