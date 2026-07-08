# KFD Support

Buildchain implements KFD support as release evidence and product capability
facts, not as README prose. The machine-readable sources are:

- `dist/site/kfd-claims.json` for Buildchain-owned public claims and KFD-3
  collaboration surfaces;
- `dist/site/public-surface-audit.json` for reverse enumeration of exposed CLI,
  workflow, action, site, and documented command surfaces;
- `buildchain.release.json` for release-specific KFD-1, KFD-2, and KFD-3
  passport results;
- `.buildchain/buildchain.toml` for repository-owned Buildchain configuration;
- `.buildchain/kfd/kfd-3-surfaces.json` for product-owned KFD-3 surface
  registration;
- `.buildchain/contract-lock.json` for accepted floating runtime contracts.

Buildchain still reads the legacy root files `buildchain.toml`,
`buildchain.contract-lock.json`, and `buildchain.kfd3.json` so existing
consumers do not break, but new repositories should keep repo-owned Buildchain
files under `.buildchain/`.

## Unified Namespace

KFD support is exposed through one first-class namespace:

```bash
buildchain kfd status --json
buildchain kfd migrate-layout --write
buildchain kfd schema list --json
buildchain kfd 1 witness --json
buildchain kfd 2 claims --json
buildchain kfd 2 trust-claims --json
buildchain kfd 2 trust-assessment --json
buildchain kfd upstream collect --json
buildchain kfd upstream check --json
buildchain kfd aggregate --json
buildchain kfd 3 query buildchain --json
buildchain kfd 4 schema --json
```

KFD-1, KFD-2, and KFD-3 have concrete Buildchain workflows. KFD-4 is currently
schema-only in Buildchain: agents can discover and read the KFD-4 schema from
`@kungfu-tech/kfd`, but Buildchain does not claim KFD-4 verification.

## KFD-1

KFD-1 proves that a product release is bound to one contract world. Buildchain
uses KFD-1 for its runtime contract, release-passport schemas, packaged docs,
Node exports, workflows, actions, and site-consumption facts.

For Buildchain itself, the source registry lives in
`packages/core/buildchain-kfd-claims.js` and is projected to
`dist/site/kfd-claims.json`. Release promotion binds that registry to exact
source and artifact hashes in the release passport.

Buildchain exposes KFD-1 through:

```bash
buildchain kfd 1 schema --json
buildchain kfd 1 witness --json
buildchain kfd 1 gate --witness-json kfd-1-witness.json --json
buildchain kfd 1 verify --gate-json kfd-1-gate.json --json
```

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

Buildchain exposes KFD-2 through:

```bash
buildchain kfd 2 schema --json
buildchain kfd 2 taxonomy --entry-json residual-risk.json --kind residualRisk --json
buildchain kfd 2 claims --json
buildchain kfd 2 trust-claims --json
buildchain kfd 2 trust-assessment --json
```

`claims` generates Buildchain's release-passport public claim inputs. The
`trust-claims` and `trust-assessment` commands expose the latest KFD package's
foundation KFD-2 facts from `@kungfu-tech/kfd` and validate their taxonomy
values against the KFD-owned `trust-taxonomy` schema. Unknown `riskType`,
`trustImpact`, `machineProvability`, or `agentAction` values fail validation;
new values must be requested upstream in `kungfu-systems/kfd`, not invented in
Buildchain.

`@kungfu-tech/kfd` is a runtime dependency of Buildchain, not a development-only
dependency. The public `buildchain kfd ...` CLI and `@kungfu-tech/buildchain/kfd`
Node API read KFD-owned standards metadata, schemas, foundation trust claims,
foundation trust assessments, and taxonomy values at runtime. Moving KFD to
`devDependencies` would make installed Buildchain packages unable to answer KFD
queries in consumer repositories.

## Upstream KFD Aggregation

Products often depend on multiple KFD-aware upstream components. A product's own
KFD status is not the same thing as the status of those upstreams, but agents
still need one machine-readable view of the upstream trust surface.

Buildchain exposes that view through:

```bash
buildchain kfd upstream collect --json
buildchain kfd upstream check --json
buildchain kfd aggregate --json
```

`upstream collect` reads `.buildchain/buildchain.toml`, resolves declared
packages from the caller repository, hashes declared evidence assets, and emits
a `kungfu-buildchain-kfd-upstream-aggregate` document. `upstream check` validates
that aggregate. `aggregate` combines the product's own Buildchain KFD status
with the upstream aggregate.

The repository-owned declaration is intentionally small:

```toml
[kfd.upstream]
auto_discover = false

[[kfd.upstream.components]]
id = "kfd"
role = "standard-and-schema-provider"
package = "@kungfu-tech/kfd"
repository = "kungfu-systems/kfd"
kfd_1 = "exported-witness"
kfd_2 = "exported-claim"
kfd_3 = "exported-collaboration-interface"
kfd_4 = "schema-metadata"
evidence = [
  "package:kfd.release.json",
  "package:.buildchain/kfd-1/contract-world.witness.json",
  "package:.buildchain/kfd-2/public-release-trust.claim.json",
  "package:.buildchain/kfd-3/collaboration-interface.json",
  "package:standards.json",
]
```

An upstream component may be `declared`, `aligned`, `exported-*`, or another
explicit non-passed state when the evidence is package-local. A component may
claim `passed` only when the aggregate also binds that component to a release
passport. Upstream `passed` never upgrades the product's own KFD status; it only
describes the upstream trust surface consumed by the product.

Buildchain dogfoods this model with `@kungfu-tech/kfd` as its upstream
standard-and-schema provider. The generated site bundle includes
`dist/site/kfd-upstream-aggregate.json` so downstream sites and agents can read
Buildchain's upstream KFD facts from the npm package instead of scraping
repository scripts.

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
| `declared` | The product owner accepted that candidate into `.buildchain/kfd/kfd-3-surfaces.json`. |
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

The KFD schema namespace is discovered from `@kungfu-tech/kfd/standards.json`.
For KFD-2 this includes `trustClaims`, `trustAssessment`, `trustTaxonomy`,
`releaseClaims`, and `releaseTrustPassport`. For KFD-4 Buildchain currently
exposes the KFD-owned `observerPerspective` schema only.

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
buildchain kfd 3 query --passport .buildchain/release-passport/buildchain.release.json --json
```

## Node API

The CLI is a thin wrapper over the public Node API:

```js
import {
  kfd1,
  kfd2,
  kfd3,
  kfd4,
  upstream,
  collectKfdAggregate,
  collectKfdStatus,
  collectKfdUpstreamFacts,
  checkKfdUpstreamFacts,
  listKfdSchemas,
  readKfdSchema,
} from "@kungfu-tech/buildchain/kfd";
```

Agents should start with `collectKfdStatus()` to learn which standards are
implemented and where the repository-owned Buildchain files live. For capability
use decisions, prefer `kfd3.queryCapabilities()`. The query result connects each
capability to:

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

- `buildchain kfd 1 witness --json` generates Buildchain's own KFD-1 contract
  world witness;
- `buildchain kfd 2 claims --json` generates Buildchain's own KFD-2 public
  claim evidence;
- `buildchain kfd 2 trust-claims --json` and
  `buildchain kfd 2 trust-assessment --json` expose and validate the KFD
  package's foundation KFD-2 trust facts against the latest KFD taxonomy;
- `dist/site/kfd-claims.json` declares Buildchain's own KFD-3 collaboration
  interface;
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
