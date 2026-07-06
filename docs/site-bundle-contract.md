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
  workflow-registry.json
  release-model.json
  artifact-schemas.json
  buildchain-contract.json
  product-mechanism.json
  release-provenance.json
  agent-index.json
```

`buildchain-site.json` is the top-level bundle entrypoint.
`buildchain-contract.json` is the machine-readable Buildchain runtime contract
world used by floating-ref contract locks. It records public workflow/action/CLI
surfaces, compatibility digests, and audit digests for the files that implement
those surfaces.

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
- workflow/action registry;
- release model facts;
- artifact and evidence schema index;
- Buildchain runtime contract world for `@v2` floating-ref compatibility checks;
- product mechanism manifest;
- release provenance;
- agent read order.

Future minor lines can add examples, recipes, fixture indexes, and richer
schema metadata without breaking existing consumers.

`release-propagation.md` describes the package-to-package or package-to-site
release chain model. The site bundle exposes that document and the
`release-propagation` CLI entry so downstream sites can render the current
Buildchain-owned propagation contract instead of hand-writing it.
