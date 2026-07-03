# Publish Transaction

Buildchain release promotion is not just tag movement. A release can also publish
external artifacts: npm packages, Python wheels, OCI images, binary archives,
metadata manifests, or site deployment records. Those side effects are harder
than Git refs because most registries are append-only: a failed rerun must know
which artifacts already exist, which are still missing, and whether any existing
artifact conflicts with the release material.

Buildchain v2 models that work as a release transaction.

## Why This Exists

The old ABV workflow made Git refs the visible release authority. That was
enough when "release" meant "create a version commit, move tags, and let
downstream jobs react." It is not enough when a single publish run must also
upload packages and images.

The failure mode to avoid is:

1. publish an external artifact;
2. fail before moving the exact release tag or floating channel refs;
3. rerun from a new job id with no memory of the artifact;
4. either republish something different or move refs without proving the
   already-published artifact matches the release.

The transaction gives reruns a stable identity and a machine-readable state so
Buildchain can resume safely. The identity is:

```text
repository + version + source_sha + target_ref
```

It is not the GitHub Actions run id.

## Durable State

`actions/promote-buildchain-ref` stores release transaction state in a
machine-managed Git branch:

```text
refs/heads/buildchain/release-state/<version>
```

The branch contains:

```text
state.json
evidence.json   # present after publish evidence exists
```

The local `.buildchain/release-state/...` and
`.buildchain/release-evidence/...` files are working copies. They are useful for
local inspection and lifecycle commands, but they are not the durable truth for
GitHub-hosted reruns. On action startup, Buildchain reads the durable state ref
first, restores the local working copies, and only then decides whether to
publish, repair, or finalize.

Every meaningful state transition is written to the durable ref before public
release refs move. If the durable write fails, the action fails closed.

Durable release-state refs reserve their exact version even when the public exact
tag was never created. If a later machine run sees a failed or repair-required
state for `vX.Y.Z-alpha.N` and cannot resume it with the same transaction
identity, alpha version selection must advance to the next prerelease instead
of reusing or overwriting that failed transaction slot.

## Lifecycle

Repositories declare publish work in `buildchain.toml`:

```toml
[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"
package_set_order = "platforms-first-main-last"
main_package = "@kungfu-tech/libnode"

[lifecycle.publish]
commands = [
  "python scripts/publish_wheels.py",
  "node scripts/publish-images.mjs",
  "node scripts/write-publish-evidence.mjs",
]
```

`actions/promote-buildchain-ref` runs `lifecycle.publish` only when
`publish-transaction: "true"` is set or when a `publish-command` input is
provided. The action sets:

```text
BUILDCHAIN_VERSION
BUILDCHAIN_CHANNEL
BUILDCHAIN_SOURCE_SHA
BUILDCHAIN_TARGET_REF
BUILDCHAIN_RELEASE_STATE
BUILDCHAIN_EVIDENCE_DIR
BUILDCHAIN_RELEASE_SHA
BUILDCHAIN_RELEASE_MATERIAL_SHA
BUILDCHAIN_PUBLISH_TOOLING_SHA
BUILDCHAIN_PUBLISH_EVIDENCE
BUILDCHAIN_PUBLISH_MODE
BUILDCHAIN_PUBLISH_AUTH
BUILDCHAIN_NPM_DIST_TAG
BUILDCHAIN_PACKAGE_SET_ORDER
BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE
```

Buildchain itself uses this contract for npm publishing:

```toml
[lifecycle.publish]
command = "node scripts/npm-publish-transaction.mjs"
```

That script validates that `package.json` matches `BUILDCHAIN_VERSION`, runs
`npm publish --access public --tag <BUILDCHAIN_NPM_DIST_TAG>` through npm Trusted
Publishing, and writes npm artifact evidence before the promotion action moves
public refs.

`BUILDCHAIN_RELEASE_MATERIAL_SHA` is the source material whose artifacts must
match. `BUILDCHAIN_PUBLISH_TOOLING_SHA` identifies the publishing code. A repair
run may change tooling, but material drift fails closed.

## Release Modes And Auth

Buildchain distinguishes two npm release modes:

| Mode | Use | Auth | npm operation |
| --- | --- | --- | --- |
| `publish-final-version` | normal alpha or stable publication | `trusted-publishing` | `npm publish --tag <alpha|latest>` |
| `promote-existing-version` | same-version alpha-to-latest recovery | `npm-token` | `npm dist-tag add <pkg>@<version> latest` |

The normal libnode path is `publish-final-version`: publish an alpha package set
such as `22.22.3-kf.3-alpha.0` with the `alpha` dist-tag, then publish a
distinct final package set such as `22.22.3-kf.3` with the `latest` dist-tag.
GitHub-hosted npm Trusted Publishing can authorize those `npm publish` calls
when the workflow grants `id-token: write`.

`promote-existing-version` is deliberately separate. npm Trusted Publishing does
not authorize arbitrary registry-management operations such as `npm dist-tag
add`; it authorizes publish-time package provenance. Therefore same-version
promotion must declare `auth = "npm-token"`. Buildchain runs an npm token
preflight with `npm whoami` before it writes any release transaction state or
moves a dist-tag. Missing token auth fails early with a contract error instead
of a late `E401` after publish evidence has started to move.

For package sets, `package_set_order = "platforms-first-main-last"` makes the
main package the visibility gate. Platform package side effects are planned or
retried first, and the main package or main dist-tag move happens last.

When the transaction reaches `complete`, `actions/promote-buildchain-ref`
generates `.buildchain/release-passport/buildchain.release.json` and persists
the `release-passport/*` files into the durable `buildchain/release-state/...`
ref. The passport is the stable release artifact for agents and people: it
links the package set, npm publish evidence, dist-tag evidence, build summary,
platform artifact manifests, trusted publishing metadata, release-state ref,
durable release-state SHA, and transaction result in one schema. Consumer
repositories can set `release-passport-product-name` so the passport names their
product instead of the Buildchain default.

## Evidence

The publish lifecycle must write JSON evidence. Buildchain validates common
fields and required artifact identities before final refs move.

```json
{
  "schema": 1,
  "version": "2.0.11",
  "channel": "release",
  "source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "release_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "target_ref": "release/v2/v2.0",
  "release_material_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "publish_tooling_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "artifacts": [
    {
      "group": "node",
      "kind": "npm",
      "name": "@kungfu-systems/example",
      "ref": "2.0.11",
      "digest": "sha256:..."
    },
    {
      "group": "image",
      "kind": "oci",
      "name": "ghcr.io/kungfu-systems/example",
      "ref": "2.0.11",
      "digest": "sha256:..."
    }
  ]
}
```

The generic contract is intentionally small:

- `version`, `channel`, `source_sha`, `release_sha`, and `target_ref` must match
  the promotion run;
- dist-tag promotion evidence is written beside the publish evidence as
  `dist-tag-evidence.json` and is referenced from the generated passport;
- required artifacts must appear in evidence;
- evidence used by a GitHub-hosted rerun must either be stored in the durable
  state ref or be reconstructed by a machine-verifiable consumer command;
- existing artifacts with the same identity and digest are accepted on rerun;
- missing artifacts can be published by the next run;
- an existing artifact with a different digest puts the transaction into
  `repair_required`.

Artifact identity is `group + kind + name + ref`. A required artifact that omits
`group` matches any group with the same `kind + name + ref`.

## Registry Truth Contract

Buildchain owns transaction orchestration, finalization ordering, durable state,
and generic evidence validation. It does not embed registry clients for npm,
PyPI, GHCR/OCI, GitHub Releases, S3, Conan, CMake packaging, or project-specific
download pages.

Consumer `lifecycle.publish` commands own registry truth. A valid consumer stage
must be idempotent and machine-verifiable:

- inspect the target registry before publishing;
- accept an existing exact artifact only when version, identity, digest, and
  release-source binding match;
- publish missing required artifacts;
- reject conflicting existing artifacts and write evidence that lets Buildchain
  move the transaction to `repair_required`;
- write `BUILDCHAIN_PUBLISH_EVIDENCE` after every successful inspect/publish
  cycle;
- leave floating aliases such as npm dist-tags, PyPI stable markers, OCI
  floating tags, GitHub Release "published" status, or download-page stable
  links to a finalization step after Buildchain evidence validation.

The first-class adapter surface is command-based. Projects may wrap npm, PyPI,
GHCR/OCI, GitHub Release assets, archives, SBOMs, provenance, or checksums
however they need, as long as they emit the common evidence contract.

## States

The state machine is:

```text
prepared -> publishing -> published -> finalizing -> complete
                    |            |            |
                    v            v            v
              publish_failed  repair_required failed_permanently
                    |
                    v
                abandoned
```

Supported states:

| State | Meaning |
| --- | --- |
| `prepared` | Transaction identity was created, but publish has not started. |
| `publishing` | Publish lifecycle is running or may have been interrupted. |
| `publish_failed` | Publish command failed before valid evidence was produced. |
| `published` | Evidence is valid; refs have not necessarily finalized. |
| `finalizing` | Buildchain is moving exact/floating refs or needs a later run to do it. |
| `complete` | Required evidence is valid and refs have finalized. |
| `repair_required` | Existing evidence or artifact state conflicts with expected release material. |
| `abandoned` | A human or controlled process abandoned this transaction, usually because a newer version supersedes it. |
| `failed_permanently` | Recovery should not continue without explicit override. |

`repair_required`, `abandoned`, and `failed_permanently` fail closed unless the
operator passes an explicit override. That override is for controlled repair
runs, not normal retry behavior.

## Ref Ordering

When publish transactions are enabled, promotion order is:

1. verify target source and governance;
2. create or reuse the version-state release commit;
3. acquire or resume the release transaction;
4. run `lifecycle.publish` or accept already-valid evidence;
5. validate evidence and required artifacts;
6. move exact release/prerelease tag;
7. move floating tags and channel refs;
8. mark the transaction `complete`.

If protected branches require a generated version-state PR, the transaction can
stop in `finalizing` and output `finalization-needed=true`. A later run can
resume from the same transaction state and complete ref movement without
republishing matching artifacts.

If finalization fails after an exact Git tag, a channel branch, or dev/alpha
sync ref has already moved, the next run reads the durable `finalizing` state
and continues from the recorded transaction. The current workflow SHA may be a
version-state merge commit that contains or corresponds to the transaction's
`release_material_sha`; it does not have to equal the original `source_sha` or
the transaction `release_sha`. Exact tags are accepted when they already point
at the transaction release/material SHA or the finalized channel head. Floating
channel tags and dev/alpha refs are then retried idempotently, and the
transaction is marked `complete` only after those public refs are consistent.
An exact tag at an unrelated SHA is still a material conflict and blocks
recovery.

If finalization fails after an exact Git tag is created, the next run reads the
durable `finalizing` state, verifies the exact tag points at the recorded
release SHA, and retries the remaining floating refs. An exact tag at a
different SHA is a material conflict and blocks recovery.

## CLI Recovery

Local recovery commands operate on the same state/evidence files:

```bash
node scripts/release-transaction.mjs inspect --version v2.0.11
node scripts/release-transaction.mjs recover --version v2.0.11
node scripts/release-transaction.mjs finalize --version v2.0.11
node scripts/release-transaction.mjs abort --version v2.0.11 --superseded-by v2.0.12
```

The CLI is a diagnostic and local repair surface. It reports the durable
`state_ref`, but remote durable-ref writes and public Git ref finalization are
owned by `actions/promote-buildchain-ref`, because that action runs inside the
same governed GitHub permissions and branch-protection checks as release
promotion. In other words, CLI `finalize` can mark the local transaction state
complete after valid evidence; the machine-operated public finalization path is
to rerun the promotion action.

When no state file exists, creation commands also require:

```bash
--repository kungfu-systems/buildchain \
--source-sha <sha> \
--release-sha <sha> \
--target-ref release/v2/v2.0 \
--channel release
```

## Build-Images Follow-Up

`build-images` should consume this contract rather than inventing a separate
workflow rule. The expected integration shape is:

- image build writes OCI digests into publish evidence;
- required image families are passed through `publish-required-artifacts-json`;
- reruns check GHCR or the target registry and accept existing images only when
  tag and digest match;
- preview or alpha image tags remain non-stable until the transaction evidence
  validates;
- production image aliases move only after all required image artifacts are
  present and the Buildchain exact release tag has finalized.
