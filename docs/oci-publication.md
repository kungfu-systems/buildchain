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
last_reviewed: 2026-09-06
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
