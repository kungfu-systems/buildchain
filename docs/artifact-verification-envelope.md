# Artifact Verification Envelope

Buildchain can turn a passing exact-artifact passport verification into one
sealed, versioned input for Kungfu KFX admission. The envelope carries the
public verification result together with exact package, source, dependency,
build-plan, toolchain, artifact, qualification, and verifier roots; issuer and
publisher identity; lifecycle and revocation facts; and an existing ADR-0052
KFD assessment.

The envelope does not create a second KFD evaluator. It validates and binds an
assessment produced by the Kungfu KFD lifecycle. It also does not claim that an
artifact is malware-free, universally safe, fit for every workspace, or
authorized as a Product System component.

## Public API

Import the dedicated package subpath:

```js
import {
  projectArtifactVerificationEnvelopeToKfx,
  sealArtifactVerificationReport,
  verifyArtifactVerificationEnvelope,
} from "@kungfu-tech/buildchain/artifact-verification-envelope";
```

`verifyArtifactPassport` also accepts an optional `verificationEnvelope`
object. Existing callers that omit it receive the unchanged
`kungfu-buildchain-artifact-verification` v1 result.

```js
const attestation = await verifyArtifactPassport({
  subject: "dist/example.kfx",
  passportLocation: "dist/buildchain.release.json",
  verificationEnvelope: {
    bindings,
    kfdAssessment,
    issuedAt,
    expiresAt,
    revocation,
  },
});
```

The result keeps the artifact-verification v1 fields that existing consumers
understand and adds:

- `bindings`: the schema-closed `kungfu.kfx-trust-inputs/v1` exact roots and
  identities;
- `issuedAt`, `expiresAt`, `revoked`, and a root-bound `revocation` fact;
- `kfdAssessment`: the pinned fresh `kungfu.trust.assessment/v1` lifecycle
  result;
- `envelope`: the envelope contract, canonicalization version, and exact
  content root.

`projectArtifactVerificationEnvelopeToKfx` returns the same sealed report as
`attestation`, its exact `bindings` as `trustInputs`, and its existing
`kfdAssessment`. A consumer does not reconstruct fields, recompute the KFD
decision, or inspect private Buildchain structures.

The read-only CLI uses those same functions for portable verification and
projection:

```bash
buildchain verify artifact-envelope envelope.json \
  --assessment-time 150 \
  --expected-root sha256:... \
  --expected-issuer buildchain.libkungfu.dev \
  --expected-publisher kungfu-systems \
  --expected-contract buildchain.release/v1 \
  --json

buildchain project kfx-admission envelope.json \
  --assessment-time 150 \
  --json
```

The projection's `envelopeRoot` is the same root returned by the Node verifier.
The CLI never adds consumer-side bindings or KFD conclusions.

## Canonicalization and roots

The v1 envelope uses `buildchain-stable-json/v1`: object keys are sorted
recursively, array order is retained, and the root is lowercase SHA-256 with a
`sha256:` prefix. `envelope.root` is excluded from its own root basis.

The KFD report hash is independently recomputed over the report with
`report_hash` removed. The envelope is accepted only when:

- the base artifact passport verification passes;
- `bindings.artifactRoot` equals both the exact subject digest and the matched
  passport artifact digest;
- every binding root is canonical lowercase SHA-256;
- `bindings.qualificationRoot` equals the recomputed KFD `report_hash`;
- the assessment key matches the report and its lifecycle state is `fresh`;
- the report binds purpose, query proof, contract world, policy, and at least
  one fact-surface root;
- lifecycle bounds are active and revocation facts are internally consistent;
- any caller-pinned envelope root, issuer, publisher, or contract version
  matches exactly.

## Fail-closed behavior

`verifyArtifactVerificationEnvelope` returns a machine-readable check report.
It rejects sibling artifacts, root tampering, identity drift, invalid contract
versions, expired or revoked envelopes, stale assessments, altered KFD report
content, and missing fact-surface bindings. Callers may pin expected authority
fields without changing the envelope.

The canonical root detects changed serialized content; authenticity still
depends on the pinned Buildchain verifier and release passport authority. The
envelope is supply-chain and evidence input. Kungfu Product and Workspace
policy retain operation, capability, and System-role authority.
