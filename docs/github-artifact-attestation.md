---
status: draft
period: 2026-07
theme: buildchain-linux-artifact-provenance
doc_type: protocol
source_level: code-and-official-docs
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-24
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-24
  visible_context: Buildchain source, tests, GitHub Actions documentation, and actions/attest documentation
  invisible_context: Model internals and provider-side implementation details are not visible
---

# GitHub-native Linux Artifact Attestation

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
`actions/github-artifact-attestation` from an exact Buildchain commit. It
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

Both caller and reusable workflow grant only:

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

## Prepare the Release Passport

Create one input document for each Linux artifact and seal it as a policy:

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

The build, Passport, and attestation jobs must stay in the same workflow run.
The release-candidate build declares both the subject and the already-merged
signer bootstrap commit. The Buildchain runtime remains the exact runtime ref
used by the build workflow and may be a later commit:

```yaml
with:
  github-artifact-attestation-subject-path: dist/kungfu-linux-x64.tar.gz
  github-artifact-attestation-signer-sha: <exact-signer-bootstrap-sha>
  github-artifact-attestation-platform-id: linux-x64
```

For release promotion, prefer the integrated v3 route. The policy must already
be present in the downloaded release-candidate payload:

```yaml
permissions:
  actions: write
  artifact-metadata: write
  attestations: write
  checks: write
  contents: write
  id-token: write
  issues: write

jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@<exact-buildchain-v3-runtime-sha>
    with:
      buildchain-ref: <exact-buildchain-v3-runtime-sha>
      github-release: true
      release-passport: true
      github-artifact-attestation-policy-json: .buildchain/release-candidate/payload/<artifact>/policy.json
      github-artifact-attestation-environment: buildchain-artifact-attestation
```

Promotion binds the policy into the Passport, stages only digest-matching data,
calls the exact v3 signer, verifies the provider identity a second time, and
publishes immutable bundle, predicate, verification, evidence, and receipt
assets beside the release artifact. A same-name Release asset with different
bytes is rejected instead of overwritten.

Low-level callers may call the reusable attester directly after their Passport
job. Both the reusable workflow ref and `buildchain-ref` use the same exact
40-hex signer-bootstrap commit and fail closed if the provider identity differs:

```yaml
jobs:
  attest-linux:
    needs: [build-linux, release-passport]
    permissions:
      actions: read
      artifact-metadata: write
      attestations: write
      contents: read
      id-token: write
    uses: kungfu-systems/buildchain/.github/workflows/github-artifact-attestation.yml@<exact-signer-bootstrap-sha>
    with:
      buildchain-ref: <exact-signer-bootstrap-sha>
      evidence-run-id: ${{ github.run_id }}
      source-sha: ${{ github.sha }}
      subject-artifact-name: linux-release
      subject-relative-path: libnode-linux-x64.tar.gz
      platform-manifest-artifact-name: linux-platform-manifest
      platform-manifest-relative-path: manifest.json
      release-passport-artifact-name: release-passport
      release-passport-relative-path: buildchain.release.json
      policy-json: ${{ needs.release-passport.outputs.github-attestation-policy-json }}
      evidence-artifact-name: linux-attestation-evidence
```

## Verify Online and Offline

The Buildchain verifier reconstructs exact `gh attestation verify` arguments
from the policy, including repository, signer workflow, signer digest, source
digest, predicate type, and self-hosted-runner denial. It then verifies the
local artifact, platform manifest, Release Passport, retained Sigstore bundle,
custom predicate, and Buildchain evidence root:

The reusable workflow runs that same exact signer/source verification
immediately after `actions/attest` and before it finalizes or uploads evidence.
Passing a different `buildchain-ref` than the commit used to invoke the reusable
workflow therefore fails in the signer job, not only during later consumption.
The policy additionally retains the distinct Buildchain runtime SHA that
created the build and release evidence.

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

New protocol work qualifies on the Buildchain v3 alpha line first. The v2
development branch is not a supported landing target. Production
adoption waits for the exact v3 implementation commit to pass the repository
suite and a real GitHub OIDC/Sigstore qualification run, including the negative
cases above. A successful local fixture is necessary but not sufficient.
