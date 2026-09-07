---
status: draft
period: ongoing
theme: oci-publication
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-07
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-06
  invisible_context_boundary: No credentials or production registry state inspected.
---

# OCI image family publication

Buildchain v4 can publish a sealed family of container images to GHCR through
`publish-artifact-kind: oci` on the public release candidate promotion workflow.
The candidate build produces the image bytes and smoke evidence. The built-in
provider verifies and uploads those bytes, reads back every public image digest,
then allows release references and GitHub Release evidence to converge.

## Candidate contract

Publish exactly one `oci-family.json` alongside OCI layouts and smoke JSON files
in the Build artifact. Import `sealOciPublicationBundle` from
`@kungfu-tech/buildchain/oci-publication` to validate and seal the family. Its
`body` contains:

- `schema: kungfu-buildchain-oci-family/v1`, consumer `repository`, exact Git
  `sourceSha`, and candidate package `version`.
- `expectedImages`: the complete set of image names.
- `images`: one entry for each expected image, with `name`, `repository`,
  `digest`, `layout`, `platform`, `action`, `content`, and `smoke`.

Destinations must be `ghcr.io/<consumer-owner>/<consumer-repo>/<image-name>`.
`layout` is a relative OCI layout directory. Each image is a single Linux
amd64 or arm64 manifest; OCI and Docker schema 2 manifests are supported.
Layouts may share blobs and an index; each shared index entry identifies its
image with the `org.opencontainers.image.ref.name` annotation.

`content` records the image's original `sourceSha` and `version`, matching its
OCI revision/version labels. For `action: built`, both equal the candidate.
For `action: reused`, they retain the original content provenance while the
family binds the current candidate. `smoke` records a relative `path` and SHA256
`sha256`; its JSON must identify the image and record `passed: true`. The
consumer owns the actual smoke command and must fail the build if it fails.

Sealing verifies all config/layer sizes and digests, platform and provenance
labels, smoke bytes, and family completeness. Absolute paths, traversal, and
symlinks are rejected. The resolver derives the exact required image artifacts
from this sealed family, including when recovering a previous candidate run.

## Authority and publication

The thin caller grants `packages: write` in addition to its existing promotion
permissions. Reusable promotion wrappers inherit that caller envelope; npm
consumers do not need to request package registry authority. The provider uses
the action token only for GHCR, scoped to each declared consumer image.
No consumer publish command is executed.

The rooted product plan declares version-state materialization, OCI family
publication, then release reference convergence. Each image uses the exact
`v<version>` tag. A different existing digest aborts publication; a matching
existing image is reused. After a partial failure, recovery validates the same
candidate bytes and publishes only missing images. GHCR does not provide tag
compare-and-swap: callers must serialize publishers for a version, and external
writers must not race the publication workflow.

Success requires anonymous readback of every declared image at its expected
digest. Existing GHCR packages must permit the repository token to write and
anonymous clients to pull. The provider does not change package visibility or
access policy. It attaches `oci-publication-readback.json` to the GitHub Release;
the caller should also include the family and smoke JSON files in
`github-release-payload-patterns`.

See [Runtime Train Validation](runtime-train-validation.md) for testing an
unreleased runtime without persisting a train or exact SHA in the workflow.

## Multi-platform images and Compose applications

Use `schema: kungfu-buildchain-oci-family/v2` when the family includes an OCI
index or a Compose application. Existing v1 families keep their published
single-platform contract.

An index entry declares `platform: multi-platform` and the complete `platforms`
array, for example `["linux/amd64", "linux/arm64"]`. Every runnable child must
have matching platform and content labels. Descriptor sizes, digests and media
types are verified recursively; nested manifests are uploaded before their
parent index. BuildKit attestation manifests must identify a runnable child and
contain matching in-toto subjects. Missing platforms, duplicate platforms,
foreign URLs and broken blob references fail sealing. Embedded descriptor `data`
is accepted only as canonical Base64 for at most 1 MiB, with the declared size
and digest matching the required local blob byte for byte. Malformed or
inconsistent embedded content fails sealing; manifests are never rewritten.
This follows the [OCI embedded-content contract](https://github.com/opencontainers/image-spec/blob/main/descriptor.md#embedded-content).

A Compose entry declares `kind: compose`, `platform: compose`, and `targetImage`
pointing to an image in the same family. Its unique family name may differ from
that image, but its destination repository must match it. The immutable tag is
`compose-v<version>`; image entries retain `v<version>`.

The bounded Compose representation is an OCI 1.1 image manifest with
`artifactType: application/vnd.docker.compose.project`, an empty JSON config
and one `application/vnd.docker.compose.file+yaml` layer. That layer contains
JSON, a YAML subset, so structural verification needs no executable YAML loader.
Every service image is pinned to a digest and at least one uses the exact
family image. Environment interpolation inside other fields can remain intact.
These media types follow the [Docker Compose publisher](https://github.com/docker/compose/blob/v5.1.2/internal/oci/push.go).

Candidate smoke evidence describes its actual pre-publication checks. It must
not claim that an unpublished public Compose reference was installed. Public
installation qualification occurs after immutable publication and before a
preview alias moves.

## Evidence-gated Compose preview

An optional Compose `preview` declaration contains exactly the supported alias
`compose-preview`, the previously accepted `previousDigest` (or `none`), and
`qualificationWorkflow`, a repository workflow path. The immutable family seals
this policy before any publication effect.

After v4 publication is complete, dispatch that qualification workflow on the
exact published alpha tag. It must pull the immutable public image and Compose,
run fresh installation, restart, account-isolation, runtime-hardening, upgrade
and rollback checks, and qualify both Linux architectures. The workflow has no
registry write authority. Upload one artifact named
`oci-compose-qualification-<run-id>-<run-attempt>` containing `qualification.json`
and its hash-bound JSON evidence files.

The receipt uses `schema: kungfu-buildchain-compose-qualification/v1` and binds
`repository`, `tag`, published `sourceSha`, sealed `familyRoot`, `runId`,
`runAttempt`, exact `image` and `application` repository/digest references,
`previousDigest`, and `passed: true`. Its `checks` object requires all of
`freshInstall`, `restartPersistence`, `upgradePersistence`, `rollbackPersistence`,
`accountIsolation`, and `hardenedRuntime` to be true. Its `platforms` object
requires `linux/amd64` and `linux/arm64` entries with `passed: true`; `evidence`
contains nonempty `{path, sha256}` bindings to the actual JSON results.

A thin consumer workflow listens to completion of that qualification workflow
and calls `public-release-oci-compose-preview.yml@v4-alpha`, passing
`BUILDCHAIN_PROMOTION_TOKEN`. The reusable workflow resolves its own exact
runtime, enforces the dual floating-channel locks, verifies the public v4
settlement, family and provider readback roots, and checks the live GitHub run's
repository, source, workflow, event, attempt and successful conclusion. It never
executes the consumer's artifact files. Only then does it copy the exact Compose
manifest bytes to the declared alias and verify the public digest.

The expected-old digest is checked immediately before mutation. An already
matching target is an idempotent success; any other drift blocks the move.
Publishers for this alias share repository-level concurrency. GHCR has no atomic
tag compare-and-swap, so external writers must also avoid racing this workflow.
The immutable release retains the appended
`buildchain-compose-preview-<run-id>-<run-attempt>.json` receipt. A failed
qualification leaves the existing preview intact, while the immutable alpha
and its original publication evidence remain available for diagnosis.
