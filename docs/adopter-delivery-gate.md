---
status: active
period: ongoing
theme: adopter-delivery-gate
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-12
  invisible_context: not asserted
---

# Adopter Delivery Gate

Buildchain exposes one protocol-neutral delivery gate. A caller registers an
exact semantic protocol driver and an exact artifact profile, then evaluates a
rooted project instance request. The core does not branch on project identity
and does not infer KFD semantics.

```js
import {
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
} from "@kungfu-tech/buildchain/adopter-delivery-gate";
import { createKfdAdopterCategoryProtocolDriver } from "@kungfu-tech/buildchain/kfd-adopter-category-driver";

const gate = createAdopterDeliveryGate({
  drivers: [createKfdAdopterCategoryProtocolDriver()],
  artifactProfiles: [createPackageArtifactProfile()],
});
const result = gate.evaluate(request, {
  adopterManifest,
  verifiedAt: "2026-08-12T00:00:00.000Z",
  maxAgeSeconds: 86400,
});
```

The KFD driver consumes only the installed published `@kungfu-tech/kfd`
category catalog, manifest verifier, resolver and category-instance verifier.
Caller-supplied catalog overrides are ignored. The legacy driver is a separate
one-way adapter for the existing standard adopter manifest and support-matrix
projection; it is not KFD declaration authority.

### Buildchain delivery-infrastructure instance

`@kungfu-tech/buildchain/buildchain-delivery-infrastructure` constructs the
Buildchain-owned project instance for the published
`kfd.adopter-category/delivery-infrastructure@1.0.0` profile. Callers provide a
release-bound full-cut adopter manifest plus exact source, package, release, and
project evidence coordinates. The constructor derives the selected obligation
set from published KFD bytes and stamps every evidence item with the same
project, adopter-manifest, package-cut, and category-selection roots.

The constructor rejects private or unknown requirement IDs instead of silently
extending the KFD profile. Verification delegates back to the published KFD
full-manifest and category-instance verifiers. A passing instance is still a
declaration-only, non-transferable result: it grants no runtime, publication,
promotion, or certification authority. Buildchain's anti-circular N-1 release
qualification remains a separate release gate.

### Buildchain anti-circular bootstrap

`@kungfu-tech/buildchain/buildchain-delivery-bootstrap` verifies that one exact
candidate is supported by a distinct protected and publicly released N-1 cut,
its passed project gate result, and its merged Delivery Warrant evidence. The
candidate must name the exact authority version; source or package reuse is
rejected. Changes to the gate, protocol, or selected profile additionally need
content-rooted compatibility and independent-review evidence.

The result is evidence only. It always retains `qualifying: false`,
`selfCertified: false`, and `releaseAuthorized: false`; publication and release
authority remain with the protected delivery and release mechanisms.

## Fail-closed boundaries

- Driver and artifact-profile selection require an exact `id@version` match.
- Package, Git commit and custom immutable artifact kinds use explicit profiles.
- Unknown fields, malformed roots, non-JSON declarations, driver exceptions,
  ambiguous kinds, stale KFD cuts and substituted evidence fail closed.
- Every result retains `qualifying: false` and `selfCertified: false`.
- Category conformance never grants runtime permission, release authorization
  or independent certification.

## Release Passport binding

Use `@kungfu-tech/buildchain/adopter-delivery-passport` to create and validate
the exact binding. Release Passport and artifact evidence must contain the same
rooted gate closure; neither side may introduce or replace delivery evidence.

## Offline vectors

`@kungfu-tech/buildchain/adopter-delivery-vectors` exports the immutable
`ADOPTER_DELIVERY_VECTOR_SUITE`. Its root binds golden two-driver replay,
unknown-driver rejection, published-KFD category conflict, evidence
substitution, stale package cut and driver-fault redaction. Consumers can call
`validateAdopterDeliveryVectorSuite()` before replay and use
`getAdopterDeliveryVector()` to select one named case.

The suite records KFD package and vector subpaths as authority coordinates. It
does not copy KFD category policy into Buildchain.
