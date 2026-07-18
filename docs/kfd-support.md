# KFD Support

Buildchain implements KFD support as release evidence and product capability
facts, not as README prose. The machine-readable sources are:

- `dist/site/kfd-claims.json` for Buildchain-owned public claims and KFD-3
  collaboration surfaces;
- `dist/site/public-surface-audit.json` for reverse enumeration of exposed CLI,
  workflow, action, site, and documented command surfaces;
- `buildchain.release.json` for release-specific KFD-1, KFD-2, KFD-3, and KFD-7
  passport results;
- `.buildchain/buildchain.toml` for repository-owned Buildchain configuration;
- `.buildchain/kfd/kfd-2/registry.json` for product-owned KFD-2 public claim
  declarations;
- `.buildchain/kfd/kfd-3/surfaces.json` for product-owned KFD-3 surface
  registration;
- `.buildchain/contract-lock.json` for accepted floating runtime contracts.

Buildchain still reads the legacy root files `buildchain.toml`,
`buildchain.contract-lock.json`, `buildchain.kfd3.json`, and the historical
`.buildchain/kfd/kfd-3-surfaces.json` registry so existing consumers can run
`buildchain kfd migrate-layout --write`. New repositories should keep
repo-owned Buildchain files under `.buildchain/`, with all KFD evidence under
`.buildchain/kfd/`.

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
buildchain kfd upstream roles --json
buildchain kfd upstream collect --json
buildchain kfd upstream check --json
buildchain kfd aggregate --json
buildchain kfd 3 query buildchain --json
buildchain kfd 4 schema --json
```

KFD-1, KFD-2, and KFD-3 have concrete Buildchain namespace workflows. KFD-7
has a concrete release-passport gate exposed by `collect github-release` and
the public `@kungfu-tech/buildchain/kfd7-release-gate` API. KFD-4 is currently
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
buildchain kfd 2 product-claims check --json
buildchain kfd 2 product-claims write --json
buildchain kfd 2 product-claims render --json
buildchain kfd 2 trust-claims --json
buildchain kfd 2 trust-assessment --json
```

Products declare their own public trust intent once in the canonical tracked
registry:

```text
.buildchain/kfd/kfd-2/registry.json
```

The registry uses
`kungfu-buildchain-kfd-2-product-claims-registry/v1` and binds each claim to a
source, machine-readable evidence, artifact coordinates, verification command,
audit boundary, responsibility, residual risk, and canonical status. Buildchain
does not invent product claims from prose. It validates the declaration, hashes
the referenced files, and renders the release-facing outputs:

```text
.buildchain/kfd/kfd-2/release-claims.json
.buildchain/kfd/kfd-2/claims/<claim-id>.json
.buildchain/kfd/kfd-2/buildchain-claim-args.txt
```

`product-claims check` is read-only and fails on missing, stale, or unexpected
claim projections. `write` updates only the declared KFD-2 output set and
removes stale generated claim JSON files; unrelated files are preserved.
`render` prints the expected document set without writing it. Version is read
from the repository's configured Buildchain version state unless explicitly
overridden. Release pipelines may override channel, tag, or source SHA while
the registry remains the stable product-intent source.

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
buildchain kfd upstream roles --json
buildchain kfd upstream collect --json
buildchain kfd upstream check --json
buildchain kfd aggregate --json
```

`upstream collect` reads `.buildchain/buildchain.toml`, resolves declared
packages from the caller repository, hashes declared evidence assets, and emits
a `kungfu-buildchain-kfd-upstream-aggregate` document. `upstream check` validates
that aggregate. `aggregate` combines the product's own Buildchain KFD status
with the upstream aggregate.

This works in development before the consuming repository has published an
alpha or release. In that state Buildchain can collect and check upstream
facts, versions, hashes, roles, and residual risk, but the consuming product
must not claim its own KFD status as `passed` until a release passport verifies
that product release.

The repository-owned declaration is intentionally small. Consumers normally
declare the upstream package identity, not Buildchain's inferred role or a
duplicate semver:

```toml
[kfd.upstream]
auto_discover = false

[[kfd.upstream.components]]
id = "kfd"
package = "@kungfu-tech/kfd"
repository = "kungfu-systems/kfd"
evidence = [
  "package:kfd.release.json",
  "package:.buildchain/kfd/kfd-1/contract-world.witness.json",
  "package:.buildchain/kfd/kfd-2/release-claims.json",
  "package:.buildchain/kfd/kfd-3/collaboration-interface.json",
  "package:standards.json",
]
```

The upstream package version is a single source of truth owned by the package
manager. Put the dependency in `package.json` / the lockfile, then let
Buildchain read the installed package's real `package.json`:

```json
{
  "devDependencies": {
    "@kungfu-tech/kfd": "1.0.0-alpha.21"
  }
}
```

Most consumers should keep `@kungfu-tech/kfd` in `devDependencies`: Buildchain
uses it during CI, development checks, release evidence collection, and site
generation. Move it to `dependencies` only if the product's own runtime imports
KFD directly. Buildchain itself keeps KFD in `dependencies` because its public
CLI and Node API resolve KFD standards, schemas, taxonomy, and foundation trust
facts at runtime.

Do not repeat upstream semver values in `.buildchain/buildchain.toml`. Repeating
versions in both `package.json` and Buildchain config creates stale facts.
`upstream collect` records the actual installed package version and evidence
hashes in the aggregate output.

`kfd_1`, `kfd_2`, `kfd_3`, and `kfd_4` are optional capability-state hints. When
omitted, Buildchain treats the component as `declared`. Use explicit values only
when the upstream package really exposes the corresponding machine evidence,
for example:

```toml
kfd_1 = "exported-witness"
kfd_2 = "exported-claim"
kfd_3 = "exported-collaboration-interface"
kfd_4 = "schema-metadata"
```

An upstream component may be `declared`, `aligned`, `exported-*`, or another
explicit non-passed state when the evidence is package-local. A component may
claim `passed` only when the aggregate also binds that component to a release
passport. Upstream `passed` never upgrades the product's own KFD status; it only
describes the upstream trust surface consumed by the product.

### Upstream Roles

Consumers should normally omit `role`. Buildchain owns the role vocabulary and
infers the role from package identity and evidence. The aggregate records:

- `role` - the normalized Buildchain-managed role;
- `roleSource` - `known-package`, `evidence`, `default`, or `explicit`;
- `roleReason` - the machine-readable explanation for the chosen role.

The managed role registry is queryable:

```bash
buildchain kfd upstream roles --json
```

Current roles are:

| Role | Meaning |
| --- | --- |
| `standard-and-schema-provider` | Provides KFD standards, schemas, taxonomy, or standard-owned witness and claim facts. |
| `release-passport-and-kfd-gate-provider` | Provides release passport, KFD gate, release claim, or release governance machinery consumed by the product. |
| `kfd-aware-product-component` | A product component that exposes KFD witness, claim, collaboration-interface, or package evidence without being core KFD infrastructure. |
| `site-consumption-provider` | Provides site-consumption facts such as site manifests, site bundles, or downstream page-content contracts. |
| `unknown-kfd-upstream` | Fallback for a declared upstream that has not matched a Buildchain-known package or role-specific evidence. |

If a consumer explicitly writes `role`, it must be one of that registry. Unknown
explicit values fail closed during `upstream check`; Buildchain will not let
repositories invent local role spellings that later fragment aggregate reports.

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

## KFD-7

KFD-7 release gates validate product-owned work Profile declarations without
copying their workflow implementation into Buildchain. A declaration passed via
`buildchain collect github-release --kfd-7-declaration-json <path>` must bind:

- the exact product source SHA and KFD-verified action contract;
- matching source and released artifact surfaces;
- retained positive and negative transition reports;
- role deletion or fusion, export/import/rebuild, backend migration,
  concurrency/retry/compensation, Warrant decay or revocation, Atlas staleness
  or loss, Pursuit continuity and settlement, Episode replay and contraction,
  and cold-start continuation reports;
- KFD-2 residual-risk vocabulary, responsibility owners, and explicit
  non-claims.

The gate records `pass`, `warning`, or `fail`. Provisional and non-activated
Profiles remain warnings even when their retained evidence is internally
complete. Buildchain verifies engineering-contract evidence closure; it does
not claim to measure real-world task quality.

Buildchain also dogfoods KFD-7 through the public
`@kungfu-tech/buildchain/kfd7-buildchain-profile` projection. It reads the
existing release candidate passport, release transaction, and publication
admission authorities as one release-transaction Profile with stable Fact,
Episode, Pursuit, Atlas, and Warrant roles. The projection owns no second state
machine, store, credential, or publication authority; Buildchain's release
lifecycle vocabulary remains product-owned.

## Shifu Discovery and Distribution Declarations

Buildchain owns the repository-layout question; product tools must not copy its
internal paths. Shifu and other consumers use this sequence:

1. read the welded `.buildchain-version` pin to select Buildchain;
2. run `buildchain layout --cwd <repository> --json`;
3. read the returned `kfd.registries["kfd-3"].path`;
4. treat a surface as Shifu-managed only when its declaration contains
   `distribution.registrar="shifu"`.

The layout response uses the
`kungfu-buildchain-layout-discovery` contract with an explicit schema version.
Changing or removing its fields is a public contract change. Consumers must not
fall back to a hard-coded registry location when the command is unavailable or
returns an unsupported contract.

A Shifu distribution declaration must contain at least one task and one
artifact. Every artifact declares `kind`, `platform`, and `pathGlob`; an
optional `sha256` is a lowercase 64-character hexadecimal digest. This makes
artifact form and platform machine-readable without asking Shifu to infer them
from filenames:

```json
{
  "distribution": {
    "registrar": "shifu",
    "tasks": ["binary:build"],
    "artifacts": [
      {
        "kind": "binary",
        "platform": "linux",
        "pathGlob": "dist/binary/example-x86_64-unknown-linux-gnu.tar.gz"
      }
    ]
  }
}
```

Buildchain validates this shape whenever a KFD-3 registry is read or written.
Repositories that do not declare the registrar remain outside Shifu's
distribution jurisdiction.

## Detected, Declared, Enforced

KFD-3 surface registration uses three states.

| State | Meaning |
| --- | --- |
| `detected` | Buildchain found a candidate public surface from package metadata, wheel metadata, CLI bins, binary artifacts, docs, or site bundle facts. |
| `declared` | The product owner accepted that candidate into `.buildchain/kfd/kfd-3/surfaces.json`. |
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
  --output .buildchain/kfd/kfd-3/collaboration-interface.prebuild.json
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
  listKfdUpstreamRoles,
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
  interface, including a Shifu-owned standalone binary distribution surface;
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
