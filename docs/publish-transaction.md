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

## Lifecycle

Repositories declare publish work in `buildchain.toml`:

```toml
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
```

`BUILDCHAIN_RELEASE_MATERIAL_SHA` is the source material whose artifacts must
match. `BUILDCHAIN_PUBLISH_TOOLING_SHA` identifies the publishing code. A repair
run may change tooling, but material drift fails closed.

## Evidence

The publish lifecycle must write JSON evidence. Buildchain validates common
fields and required artifact identities before final refs move.

```json
{
  "schema": 1,
  "version": "1.0.0",
  "channel": "release",
  "source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "release_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "target_ref": "release/v1/v1.0",
  "release_material_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "publish_tooling_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "artifacts": [
    {
      "group": "node",
      "kind": "npm",
      "name": "@kungfu-systems/example",
      "ref": "1.0.0",
      "digest": "sha256:..."
    },
    {
      "group": "image",
      "kind": "oci",
      "name": "ghcr.io/kungfu-systems/example",
      "ref": "1.0.0",
      "digest": "sha256:..."
    }
  ]
}
```

The generic contract is intentionally small:

- `version`, `channel`, `source_sha`, `release_sha`, and `target_ref` must match
  the promotion run;
- required artifacts must appear in evidence;
- existing artifacts with the same identity and digest are accepted on rerun;
- missing artifacts can be published by the next run;
- an existing artifact with a different digest puts the transaction into
  `repair_required`.

Artifact identity is `group + kind + name + ref`. A required artifact that omits
`group` matches any group with the same `kind + name + ref`.

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

## CLI Recovery

Local recovery commands operate on the same state/evidence files:

```bash
node scripts/release-transaction.mjs inspect --version v1.0.0
node scripts/release-transaction.mjs recover --version v1.0.0
node scripts/release-transaction.mjs finalize --version v1.0.0
node scripts/release-transaction.mjs abort --version v1.0.0 --superseded-by v1.0.1
```

When no state file exists, creation commands also require:

```bash
--repository kungfu-systems/buildchain \
--source-sha <sha> \
--release-sha <sha> \
--target-ref release/v1/v1.0 \
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
