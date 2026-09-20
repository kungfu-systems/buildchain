---
status: draft
period: ongoing
theme: buildchain-linux-artifact-provenance
doc_type: protocol
source_level: code-and-official-docs
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Current Buildchain taxonomy and consumer contract, retained attestation implementation and protocol documentation.
  invisible_context_boundary: No fresh provider attestation or hosted qualification is asserted by this documentation update.
---

# GitHub-native Linux Artifact Attestation

This is an internal protocol reference. Consumers use the generated normal and
recovery callers described in the [Golden Path](getting-started.md); they do
not add a promotion or attester workflow, prepare policy JSON, or select source
and artifact roots. The retained internal component is
[`.release-artifact-attestation.yml`](../.github/workflows/.release-artifact-attestation.yml).

Buildchain can bind a Linux release artifact to its original compiler run, exact
source revision, platform manifest, Release Passport, and an immutable
Buildchain attester workflow. GitHub's OIDC identity and artifact attestation
service provide the keyless signature; Buildchain provides the release contract
and fail-closed local verification.

This capability proves provenance and integrity. It does not prove that source
code is safe, that a compiler was uncompromised, or that a self-hosted build
runner had no privileged observer.

## Trust Boundary

The original Linux runner remains the compiler identity. The reusable attester
runs on `ubuntu-24.04` only after the artifact, platform manifest, and Release
Passport have been sealed and uploaded. It downloads those files as data and
never checks out or executes consumer source.

The attester checks out only
`actions/build/artifact/github-attest` from an exact Buildchain commit. It
rejects a floating Buildchain ref, a different caller repository, a different
source SHA, a different workflow run, a non-Linux platform manifest, or a
subject digest absent from the Release Passport.

The protected Environment defaults to `buildchain-artifact-attestation`.
Consumer repositories should require review or restrict deployment branches on
that Environment when their release policy requires an independent gate.

## Non-circular Passport Binding

The Release Passport first records
`githubArtifactAttestations[]`, an immutable expected-attestation policy:

- artifact name, relative path, byte size, and SHA-256;
- caller repository, source commit, and source tree;
- original Linux platform and platform-manifest digest; the initial v3 contract
  requires the runner receipt root to equal that exact manifest digest;
- Buildchain signer workflow path and exact signer-bootstrap commit;
- exact Buildchain runtime commit used to build and release the artifact;
- exact GitHub permission set.

The GitHub attestation predicate then records the completed Release Passport
file digest. The returned attestation id, URL, Sigstore bundle digest, and
predicate root are written to a separate
`buildchain.github-artifact-attestation-evidence/v1` document. Keeping dynamic
provider evidence outside the Passport avoids a self-referential hash while
still binding both directions.

## GitHub Permissions and Runtime Pins

The internal attester invocation and its reusable component grant only:

```yaml
permissions:
  actions: read
  artifact-metadata: write
  attestations: write
  contents: read
  id-token: write
```

The reusable workflow pins `actions/checkout`, `actions/download-artifact`,
`actions/upload-artifact`, and `actions/attest` by full commit SHA. The workflow
itself must also be called at its exact signer-bootstrap commit. The signer
commit and the later Buildchain runtime commit are separately bound so the
first v3 integration never relies on a mutable or self-referential workflow ref.

## Internal Release Passport preparation

The runtime owns policy preparation. Maintainers can inspect the retained
policy contract with the following low-level tooling; these commands are not
consumer lifecycle steps. One input document describes each Linux artifact:

```bash
buildchain create github-artifact-attestation-policy \
  --input-json .buildchain/github-artifact-attestation/policy-input.json \
  --output .buildchain/github-artifact-attestation/policy.json
```

The input object contains `subject`, `caller`, `signer`, and `build` objects.
The CLI computes no trusted values implicitly: the caller supplies the already
measured subject size/digest, source commit/tree, platform-manifest digest,
runner receipt root, and exact Buildchain workflow commit.

Pass the policy into Release Passport collection:

```bash
buildchain collect github-release \
  --github-artifact-attestation-policy-json \
    .buildchain/github-artifact-attestation/policy.json \
  --output-dir .buildchain/release-passport \
  # ...the existing release inputs
```

The retained attestation mechanism binds the original compiler execution,
sealed candidate payload, platform manifest and Passport. Internal promotion
stages only digest-matching data, invokes the internal signer, verifies provider
identity, and retains the bundle, predicate, verification evidence and receipt.
A same-name published asset with different bytes is rejected.

Signer bootstrap identity and the runtime used to build the product remain
separate immutable facts. These fields are derived and checked inside the
runtime. Neither `public-release-promote.yml` nor
`public-release-artifact-attestation.yml` is a current consumer API; new wiring
must not copy the former v3 input sets into an extra workflow.

## Verify Online and Offline

The Buildchain verifier reconstructs exact `gh attestation verify` arguments
from the policy, including repository, signer workflow, signer digest, source
digest, predicate type, and self-hosted-runner denial. It then verifies the
local artifact, platform manifest, Release Passport, retained Sigstore bundle,
custom predicate, and Buildchain evidence root:

The reusable workflow runs that same exact signer/source verification
immediately after `actions/attest` and before it finalizes or uploads evidence.
The provider signer commit identifies the workflow that issued the attestation.
The selected execution runtime is separate provenance and may differ. Subject,
signer and evidence-root verification does not compare entry and runtime SHAs.

```bash
buildchain verify github-artifact-attestation \
  libnode-linux-x64.tar.gz \
  --platform-manifest manifest.json \
  --release-passport buildchain.release.json \
  --bundle attestation.sigstore.json \
  --evidence github-artifact-attestation.evidence.json
```

Verification fails if a single artifact byte changes, the source commit or
repository differs, the signer workflow or Buildchain commit differs, the
Passport was replaced, the platform manifest drifts, the bundle omits the
expected statement, or GitHub reports a self-hosted signer.

## Qualification Policy

Protocol changes land through the protected `dev/v4/v4.1` workflow and require
qualification of the exact published runtime before consumer adoption. Local
fixtures validate the protocol's negative cases; they do not substitute for a
real GitHub OIDC/Sigstore qualification run or prove provider publication.
