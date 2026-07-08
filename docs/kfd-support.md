# KFD Support

Buildchain implements KFD support as release evidence and product capability
facts, not as README prose. The machine-readable sources are:

- `dist/site/kfd-claims.json` for Buildchain-owned public claims and KFD-3
  collaboration surfaces;
- `dist/site/public-surface-audit.json` for reverse enumeration of exposed CLI,
  workflow, action, site, and documented command surfaces;
- `buildchain.release.json` for release-specific KFD-1, KFD-2, and KFD-3
  passport results;
- `buildchain.kfd3.json` for product-owned KFD-3 surface registration.

## KFD-1

KFD-1 proves that a product release is bound to one contract world. Buildchain
uses KFD-1 for its runtime contract, release-passport schemas, packaged docs,
Node exports, workflows, actions, and site-consumption facts.

For Buildchain itself, the source registry lives in
`packages/core/buildchain-kfd-claims.js` and is projected to
`dist/site/kfd-claims.json`. Release promotion binds that registry to exact
source and artifact hashes in the release passport.

## KFD-2

KFD-2 requires public trust claims to be backed by machine-readable evidence.
Buildchain release passports fail or downgrade claims that only have prose.

Every public claim binds:

- declared source files;
- machine-readable evidence;
- source, evidence, and artifact hashes;
- artifact coordinates;
- verification result;
- audit boundary;
- responsibility state;
- residual risk.

## KFD-3

KFD-3 closes participant-facing collaboration surfaces over a declared public
interface. Buildchain supports two complementary KFD-3 layers.

The first layer is Buildchain self-verification. Buildchain reverse-enumerates
real CLI commands, reusable workflow inputs, action inputs, site pages, and
documented command references, then compares those facts with the generated
registries in `dist/site/`. A missing registry entry fails `pnpm run check`.

The second layer is product surface registration. Products can ask Buildchain to
detect standard public surfaces, write a small product-owned registry, audit the
registry against the current artifact/source tree, generate a release-passport
compatible witness, and query the resulting capability map.

## Detected, Declared, Enforced

KFD-3 surface registration uses three states.

| State | Meaning |
| --- | --- |
| `detected` | Buildchain found a candidate public surface from package metadata, wheel metadata, CLI bins, binary artifacts, docs, or site bundle facts. |
| `declared` | The product owner accepted that candidate into `buildchain.kfd3.json`. |
| `enforced` | The product has promoted a declared surface to a hard release boundary. Missing enforced surfaces fail release verification. |

Detection does not silently become product intent. `register` is the boundary
decision. Existing consumers are unaffected until they opt in.

## CLI

Inspect KFD-owned schema facts:

```bash
buildchain kfd schema list --json
buildchain kfd schema show kfd-1 --json
buildchain kfd 4 schema --json
```

Detect public surface candidates:

```bash
buildchain kfd 3 detect --json
buildchain kfd 3 detect --kind node-api --kind cli --json
```

Register standard surface classes:

```bash
buildchain kfd 3 register node-api --product Buildchain
buildchain kfd 3 register cli
buildchain kfd 3 register python-api --artifact dist/wheel-unpacked
```

Audit detected, declared, and enforced surfaces:

```bash
buildchain kfd 3 audit --json
```

Generate a witness for release passport collection:

```bash
buildchain kfd 3 witness \
  --kind prebuild \
  --output .buildchain/kfd-3/collaboration-interface.prebuild.json
```

Query capability facts for agents or downstream sites:

```bash
buildchain kfd 3 query buildchain --json
buildchain kfd 3 query --passport buildchain.release.json --json
```

## Node API

The CLI is a thin wrapper over the public Node API:

```js
import {
  kfd3,
  listKfdSchemas,
  readKfdSchema,
} from "@kungfu-tech/buildchain/kfd";
```

Agents should prefer `kfd3.queryCapabilities()` when deciding whether a product
capability is usable. The query result connects each capability to:

- KFD-3 surface identity and state;
- KFD-1 basis facts such as source and artifact paths or digests;
- KFD-2 trust evidence when a release passport is attached;
- residual risk and recommended agent action.

## Standard Detectors

The initial detector set is intentionally conservative:

- npm packages: `package.json` `exports`, `main`, `types`, and `bin`;
- Python wheels: unpacked `.dist-info/METADATA`, `RECORD`,
  `entry_points.txt`, and `top_level.txt`;
- CLI binaries: `package.json#bin` and files under `bin/`;
- standalone binaries and archives: common binary/archive outputs under
  artifact directories such as `dist/`;
- documentation: `README.md`, `AGENTS.md`, and `docs/*.md`;
- site bundles: `dist/site/*.json`.

Python importability alone is not considered public API. A product can extend
the registry over time, but the first boundary is metadata-based.

## Buildchain Self Dogfood

Buildchain dogfoods this model in two ways:

- `dist/site/kfd-claims.json` declares Buildchain's own KFD-3 collaboration
  surface;
- `buildchain kfd 3 query buildchain --json` resolves the packaged
  Buildchain capability map from that site fact source.

This lets downstream agents discover Buildchain's supported CLI, Node API,
release passport, workflow, and site bundle surfaces from the npm package
instead of scraping source files or README examples.

## Known Gaps

Archive unpacking for `.whl`, `.tar.gz`, `.zip`, and platform-native installers
is intentionally not part of the first detector. Callers can point
`--artifact` at an unpacked artifact directory. Future Buildchain versions can
add archive readers without changing the registry contract.
