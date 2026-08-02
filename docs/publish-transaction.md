---
status: active
period: ongoing
theme: buildchain-publish-transaction
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-31
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-31
  invisible_context: not asserted
---

# Publish Transaction

Buildchain release promotion is not just tag movement. A release can also publish
external artifacts: npm packages, Python wheels, OCI images, binary archives,
metadata manifests, or site deployment records. Those side effects are harder
than Git refs because most registries are append-only: a failed rerun must know
which artifacts already exist, which are still missing, and whether any existing
artifact conflicts with the release material.

Buildchain v3 models that work as a release transaction.

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
sealed-bundle/<candidate-root>/files/**  # present for build-once publication
```

The local `.buildchain/release-state/...` and
`.buildchain/release-evidence/...` files are working copies. They are useful for
local inspection and lifecycle commands, but they are not the durable truth for
GitHub-hosted reruns. On action startup, Buildchain reads the durable state ref
first, restores the local working copies, and only then decides whether to
publish, repair, or finalize.

Every meaningful state transition is written to the durable ref before public
release refs move. Release-state GitHub API reads and writes use retry/backoff
for transient service failures such as HTTP 5xx responses, connection resets,
timeouts, and "other side closed" socket failures. If the durable write still
cannot be persisted after retries, the action fails closed.

For a sealed publication, `state.json` also carries the typed sealed-bundle
manifest, its candidate root, publication milestones, stable
`publication_state`, and an exact resume command. The durable ref stores every
declared bundle file as binary Git blobs before the publish lifecycle starts.
A fresh runner restores those blobs into
`.buildchain/recovered-publication/<version>/`, verifies every size and SHA-256
against the manifest, and only then supplies the recovered paths to the publish
lifecycle. A missing or changed tarball, PDF, source bundle, or manifest fails
before registry publication.

Durable release-state refs reserve their exact version even when the public exact
tag was never created. If a later machine run sees a failed or repair-required
state for `vX.Y.Z-alpha.N` and cannot resume it with the same transaction
identity, alpha version selection must advance to the next prerelease instead
of reusing or overwriting that failed transaction slot.

## Lifecycle

Repositories declare publish work in `.buildchain/buildchain.toml`:

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
BUILDCHAIN_SEALED_BUNDLE_ROOT
BUILDCHAIN_SEALED_NPM_TARBALL
BUILDCHAIN_SEALED_NPM_INTEGRITY
BUILDCHAIN_SEALED_NPM_SHA256
BUILDCHAIN_REQUIRED_ARTIFACTS
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
public refs. When the sealed npm variables are present, the script verifies and
publishes that exact `.tgz` file. It does not run `npm pack` again.

`BUILDCHAIN_RELEASE_MATERIAL_SHA` is the source material whose artifacts must
match. `BUILDCHAIN_PUBLISH_TOOLING_SHA` identifies the publishing code. A repair
run may change tooling, but material drift fails closed.

## Post-Publish Requirements And Artifact Provenance

`publish-required-artifacts-json` is a pre-publish family declaration, not a
request to guess registry digests. A descriptor must include `kind + name`; it
may omit `ref` and `digest`. The action resolves a missing `ref` to the exact
`BUILDCHAIN_VERSION`. Registries whose exact refs add a stable prefix or suffix
may instead declare a `ref_template` containing exactly one `{version}`, such
as `v{version}`. The template is expanded only after exact version selection,
so a resumed alpha transaction receives the newly selected prerelease rather
than the checked-out version. Declaring both `ref` and `ref_template`, using
another placeholder, or leaving unmatched braces fails before
`lifecycle.publish`. The action exports the normalized exact refs as
`BUILDCHAIN_REQUIRED_ARTIFACTS`, runs `lifecycle.publish`, and then requires the
final evidence to contain every exact member with a non-empty digest. Existing
callers may continue supplying exact refs and digests.

OCI publishers can opt into strict per-artifact provenance by adding
`action: built` or `action: reused`. Those artifacts carry two separate
coordinates:

- `content`: the version, ref, source SHA, and material SHA that produced the
  immutable content;
- `release`: the exact current version/ref, target ref, source SHA, and release
  material SHA that bind that content into this release.

This distinction permits truthful cross-version reuse without claiming that an
old OCI config was rebuilt from current material. For an OCI artifact with an
action, final evidence also requires `platform`, positive `contract_major`, and
`verification` containing a public manifest result, exact ref and digest,
platform, contract major, optional parent digest, evidence location, and a
passed named smoke policy. Buildchain cross-checks those values against the
artifact and current transaction. Missing family members and ref, digest,
content, release, or verification conflicts enter `repair_required` before
public refs move.

Example reused OCI evidence entry (the pre-publish requirement may omit
`ref`, `digest`, `release`, and the observed verification values):

```json
{
  "group": "image",
  "kind": "oci",
  "name": "ghcr.io/kungfu-systems/base-linux",
  "ref": "1.2.0-alpha.3",
  "digest": "sha256:...",
  "action": "reused",
  "platform": "linux/amd64",
  "contract_major": 1,
  "content": {
    "version": "1.1.9",
    "ref": "1.1.9",
    "source_sha": "<source-sha>",
    "material_sha": "<material-sha>"
  },
  "release": {
    "version": "1.2.0-alpha.3",
    "ref": "1.2.0-alpha.3",
    "target_ref": "alpha/v1/v1.2",
    "source_sha": "<current-source-sha>",
    "material_sha": "<current-material-sha>"
  },
  "verification": {
    "public_manifest": true,
    "ref": "1.2.0-alpha.3",
    "digest": "sha256:...",
    "platform": "linux/amd64",
    "contract_major": 1,
    "evidence": "registry-inspect.json",
    "smoke": {
      "policy": "manifest-contract",
      "passed": true,
      "evidence": "smoke.json"
    }
  }
}
```

## Release Modes And Auth

Buildchain distinguishes two npm release modes:

| Mode | Use | Auth | npm operation |
| --- | --- | --- | --- |
| `publish-final-version` | normal alpha or stable publication | `trusted-publishing` | `npm publish --tag <alpha|vX.Y-alpha|latest>` |
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
  "target_ref": "release/v3/v3.0",
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
prepared -> sealed -> publishing -> published -> finalizing -> complete
                          |            |            |
                          v            v            v
                    publish_failed  repair_required failed_permanently
                          |
                          v
                      abandoned
```

Supported states:

| State                | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `prepared`           | Transaction identity was created, but publish has not started.                                           |
| `sealed`             | Exact candidate bytes and manifest are verified and durable; registry publication has not started.       |
| `publishing`         | Publish lifecycle is running or may have been interrupted.                                               |
| `publish_failed`     | Publish command failed before valid evidence was produced.                                               |
| `published`          | Evidence is valid; refs have not necessarily finalized.                                                  |
| `finalizing`         | Buildchain is moving exact/floating refs or needs a later run to do it.                                  |
| `complete`           | Required evidence is valid and refs have finalized.                                                      |
| `repair_required`    | Existing evidence or artifact state conflicts with expected release material.                            |
| `abandoned`          | A human or controlled process abandoned this transaction, usually because a newer version supersedes it. |
| `failed_permanently` | Recovery should not continue without explicit override.                                                  |

`repair_required`, `abandoned`, and `failed_permanently` fail closed unless the
operator passes an explicit override. That override is for controlled repair
runs, not normal retry behavior.

`publication_state` is a stable operator-facing projection over the detailed
transaction state. Its successful progression is
`prepared -> sealed -> package-published -> alpha-complete` for Alpha or
`release-complete` for stable release. If npm succeeds but GitHub Release work
is interrupted, the durable record remains `package-published`; the next run
reuses the exact npm evidence and sealed release assets instead of rebuilding
or republishing them.

## Ref Ordering

When publish transactions are enabled, promotion order is:

1. verify target source and governance;
2. create or reuse the version-state release commit;
3. acquire or resume the release transaction;
4. for build-once publication, verify and persist the complete sealed bundle;
5. run `lifecycle.publish` from the exact sealed tarball or accept already-valid
   evidence;
6. validate evidence and required artifacts;
7. move exact release/prerelease tag;
8. move floating tags and channel refs;
9. mark the transaction `complete`;
10. create or update the GitHub Release from restored sealed assets and record
    the `github_release` milestone.

When a protected channel requires a generated version-state pull request, the
first run can stop at `finalizing` after registry publication. If the reviewed
merge commit later contains that exact transaction release material but the
exact tag is still absent, a retry performs finalization only: it reloads the
same durable source, release material, tooling, evidence, version, and target
bindings; creates the exact tag at the transaction source SHA; moves floating
refs to the transaction release SHA; and completes the passport from the
transaction source tree. It does not rerun the provider mutation and does not
authorize the newer composite channel tree
as published material. A different source tree still requires a new version and
a fresh release candidate.

Deferred binary dispatch, controller-evidence bundling, and any consumer
publication commit are skipped while `finalization-needed=true`. They run only
after the exact public tag and complete release passport exist.

Consumer products that expose a signed well-known channel can opt into one
additional, deliberately final step with `publication-commit-command`. Before
that command runs, Buildchain has already completed the transaction, created
the public GitHub Release, and uploaded every release-passport file plus the
explicit PR-stage payload files selected by
`github-release-payload-patterns`. The command is therefore a commit point for
discovery authority, not another artifact publisher.

The command receives the exact version, source SHA, release SHA, release tag,
release passport path, and downloaded payload directory through
`BUILDCHAIN_PUBLICATION_COMMIT_*`. Optional consumer-owned dispatch/API
credentials and private signing material are exposed separately as
`BUILDCHAIN_PUBLICATION_COMMIT_TOKEN` and
`BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY`; Buildchain never logs, persists,
or interprets either value. The command must write
`.buildchain/publication-commit/evidence.json` (or another declared path below
`.buildchain/`) with this contract:

```json
{
  "schema": "kungfu-buildchain-publication-commit-evidence/v1",
  "status": "passed",
  "identity": {
    "version": "4.0.0-alpha.2",
    "sourceSha": "<source-sha>",
    "releaseSha": "<release-sha>",
    "releaseTag": "v4.0.0-alpha.2"
  },
  "publication": {
    "url": "https://example.test/.well-known/product/alpha.json",
    "payloadRoot": "sha256:<64-lowercase-hex>"
  },
  "readback": {
    "status": "passed",
    "url": "https://example.test/.well-known/product/alpha.json",
    "payloadRoot": "sha256:<same-root>"
  },
  "recovery": {
    "previousAuthority": "preserved",
    "rollbackReference": "sha256:<previous-root>"
  }
}
```

Buildchain rejects stale evidence, identity drift, non-public or mutable URLs,
read-back root drift, and missing recovery evidence. It also rejects
`standalone-binary-distribution=true` with a final commit command because that
would queue product mutations after the authority moved. On any command or
read-back failure, the consumer must leave the previous well-known document
authoritative; Buildchain does not retry the command behind a successful
receipt.

If protected branch finalization is interrupted after publish evidence is
valid, the transaction can stop in `finalizing` and output
`finalization-needed=true`. A later run resumes from the same transaction state
and completes ref movement without republishing matching artifacts. New
Buildchain-managed promotions first try to finish generated version-state
bookkeeping with the promotion token directly. Before patching a protected
generated bookkeeping ref, Buildchain emits every configured required check on
the exact generated version-state commit so branch protection can
validate the automation path without a second build, then uses the generated
ref update token for the protected ref PATCH. If release finalization
bookkeeping is still rejected, Buildchain creates or reuses a same-repository
`buildchain/version-state/*` PR and leaves the transaction resumable with
`finalization-needed=true`. Strict alpha uses the same protected PR fallback
for both its target channel and subsequent dev reconciliation. A later
idempotent run continues only after the provider shows that the PR reached the
protected branch. The reusable wrapper binds that token to the run-scoped
`github.token` and rejects user, team, or alternate App bypass actors.

If finalization fails after an exact Git tag, a channel branch, or dev/alpha
sync ref has already moved, the next run reads the durable `finalizing` state
and continues from the recorded transaction. The current workflow SHA may be a
generated version-state commit, or a historical version-state merge commit, that
contains or corresponds to the transaction's `release_material_sha`; it does not
have to equal the original `source_sha` or the transaction `release_sha`. Exact
tags are accepted when they already point at the transaction release/material
SHA or the finalized channel head. Floating
channel tags and dev/alpha refs are then retried idempotently, and the
transaction is marked `complete` only after those public refs are consistent.
Writing `complete` clears any stale `failure` value from earlier attempts, so
the durable `state.json` represents the successful final state instead of the
last transient error seen before a rerun.
An exact tag at an unrelated SHA is still a material conflict and blocks
recovery.

For anchored package versions, the package version and internal line tag are
separate transaction coordinates. A retry can correct a stale internal tag on
an unfinished `published` or `finalizing` transaction only when its validated
evidence and complete artifact set match the same package version, source,
release material, and target. Buildchain additionally requires that the stale
tag does not already point at the transaction and that the newly selected tag
is unclaimed or already points at accepted release material. No registry publish
command is rerun during this exact-tag rebind.

Governed retries distinguish unrelated channel advancement from advancement
made by their own durable transaction. An unrelated descendant remains an
auditable `superseded-promotion` no-op. When the target ref is exactly the
recorded `release_sha` for the requested source, target, and expected version,
Buildchain resumes finalization, restores publish evidence, and emits the
release-passport paths needed by downstream controller receipts.

Publication authority planning applies the same occupied-version rule as the
later mutation step. If a current alpha transaction already contains published
material and regenerating version state would create new release material, the
planner advances to the next alpha before sealing authority. It never seals the
old published version and then lets the publisher discover a different version
inside the mutation boundary.

If finalization fails after an exact Git tag is created, the next run reads the
durable `finalizing` state, verifies the exact tag points at the recorded
source SHA (while accepting legacy release/material targets for recovery), and
retries the remaining floating refs. An exact tag at an unrelated SHA is a
material conflict and blocks recovery.

## CLI Recovery

Local recovery commands operate on the same state/evidence files:

```bash
node scripts/release-transaction.mjs inspect --version v3.0.2
node scripts/release-transaction.mjs recover --version v3.0.2
node scripts/release-transaction.mjs finalize --version v3.0.2
node scripts/release-transaction.mjs abort --version v3.0.2 --superseded-by v3.0.3
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
--target-ref release/v3/v3.0 \
--channel release
```

## Build-Images Follow-Up

`build-images` should consume this contract rather than inventing a separate
workflow rule. The expected integration shape is:

- image build writes OCI digests into publish evidence;
- required image families are passed through `publish-required-artifacts-json`
  before their final digests are known;
- mixed built/reused evidence preserves content provenance separately from the
  current release binding;
- reruns check GHCR or the target registry and accept existing images only when
  tag and digest match;
- preview or alpha image tags remain non-stable until the transaction evidence
  validates;
- production image aliases move only after all required image artifacts are
  present and the Buildchain exact release tag has finalized.
