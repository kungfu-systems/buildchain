---
status: preview
period: 2026-08-27
theme: buildchain-v4-adopter-delivery
doc_type: product-manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-27
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-27
  visible_context: Exact protected v3 adopter-delivery cut, v4 pure contract core, published npm archive bytes, public consumer policy, complete v3 capability inventory, and rooted cross-platform qualification reports.
  invisible_context_boundary: No credentials, provider mutations, signing operations, publication operations, or release authority were used.
---

# V4 Public Adopter Delivery

Buildchain v4 carries the v3 adopter-delivery capability through a public,
protocol-neutral boundary. Consumers select an exact protocol driver and
artifact profile, retain the rooted gate result, and independently recompute
that readback. Buildchain does not interpret a protocol owned by another
project and a passing result never grants runtime, provider, signing,
publication, or release authority.

The parity source is the read-only protected cut
`dev/v3/v3.0@6b96bdad8d9f8ccf9275f27d9370a226a9c78465`. Work began from the
minimal v4 absorption base
`dev/v4/v4.0@e5611377efc03178f8687d99968cfdfa3ce2825b` and absorbed the
verified protected-base advances through
`dev/v4/v4.0@e0342713c7447960c13bd73377282b2e93f4853d` before delivery. These
identities, the v3 vector-suite root, and the KFD package cut are committed in
[`v4-adopter-delivery-parity.json`](../architecture/v4-adopter-delivery-parity.json)
and exposed by the public Node API.

## Public contract

The JSON input schema is
[`v4-adopter-delivery-v1.schema.json`](../contracts/v4-adopter-delivery-v1.schema.json).
An input names both selectors and the exact request identities. A selector
whose implementation identity differs from the request fails closed. The
public selectors are `json-assertion`, `kfd-category`, and `legacy-kfd`, with
`git-commit` and `package` artifact profiles.

Applications can also import the lower-level driver interface from
`@kungfu-tech/buildchain/adopter-delivery-gate` and define an isolated driver.
The v4 convenience runtime, exact source declaration, readback verification,
N-1 lineage check, and published archive loader are exported from
`@kungfu-tech/buildchain/v4-adopter-delivery`.

## CLI

All four operations are offline after the declared archive bytes exist:

```sh
buildchain adopter-delivery run \
  --input contracts/fixtures/v4-adopter-delivery-v1/gate-positive.json \
  --output .buildchain/adopter-delivery/readback.json

buildchain adopter-delivery verify \
  --input contracts/fixtures/v4-adopter-delivery-v1/gate-positive.json \
  --readback .buildchain/adopter-delivery/readback.json

buildchain adopter-delivery bootstrap \
  --input contracts/fixtures/v4-adopter-delivery-v1/bootstrap-positive.json

buildchain adopter-delivery archive \
  --input contracts/fixtures/v4-adopter-delivery-v1/archive-template.json
```

`verify` requires the complete rooted readback and recomputes it. Missing or
substituted readback, unknown selector, unknown driver, protocol-version
mismatch, archive-byte or package-identity mismatch, and altered bootstrap
lineage all fail closed.

## N-1 and published archives

N-1 bootstrap is distinct from the candidate. The lineage wrapper requires
the exact v3 authority commit, exact v4 absorption base, and exact public
Buildchain archive root. The retained v3 bootstrap also requires protected and
published N-1 authority, rejects self-authorization, binds the candidate gate
artifact, and requires merged Warrant-shaped evidence. Protocol, profile, or
gate changes require independently reviewed transition evidence.

Published authority loading verifies compressed bytes before extraction,
rejects unsafe paths and links, verifies extracted package identity, verifies
KFD's semantic package root, and imports only declared public delivery modules.
The caller must supply an independently retained authority readback root. The
fixture binds `@kungfu-tech/buildchain@3.0.9-alpha.16` and
`@kungfu-tech/kfd@1.0.0-alpha.65`; a package version is not treated as proof of
the Git source cut.

## Config and reusable workflow

Consumer configuration is closed and repository-relative:

```toml
[adopter_delivery]
contract = "kungfu-buildchain-v4-adopter-delivery/v1"
input_path = "contracts/adopter-delivery/input.json"
readback_path = ".buildchain/adopter-delivery/readback.json"
bootstrap_path = "contracts/adopter-delivery/bootstrap.json"
archive_path = "contracts/adopter-delivery/archives.json"
result_path = ".buildchain/adopter-delivery/result.json"
driver_selector = "kfd-category"
artifact_profile_selector = "package"
```

The public reusable workflow is
`kungfu-systems/buildchain/.github/workflows/v4-adopter-delivery.yml@v4` for
stable use and `@v4-alpha` during prerelease evaluation. It resolves the exact
called-workflow SHA, enforces floating selector plus dual-lock consumer
admission, and runs the same CLI on Linux, macOS, and Windows. Buildchain
dogfoods it through the thin
[`v4-adopter-delivery-dogfood.yml`](../.github/workflows/v4-adopter-delivery-dogfood.yml)
caller, which contains no steps or local orchestration and persists only the
floating `@v4-alpha` selector.

The reusable workflow downloads exact public N-1 npm archives and uses the
committed byte roots, semantic identity, and authority readback root. It has
only `contents: read`; no provider credential or production writer is accepted
or synthesized.

## Cross-platform capability qualification

The reusable workflow also produces a rooted report on `linux-x64`,
`macos-arm64`, and `windows-x64`. Each report binds `job.workflow_sha`, the
consumer source SHA, and the complete 4,648-row v3-to-v4 inventory. Source-only
capabilities retain their raw category counts with an `exact-source-route`
applicability; they are not mislabeled as operating-system executions.

The executable boundary is exercised rather than inferred: a public run must
pass, a substituted readback must fail, retry must reproduce the original root,
terminal verification and N-1 bootstrap must pass, and the independent
`ledger-specification-driver` clean-room test must pass without a KFD package.
The workflow then reconciles one exact report from each platform. Final family
qualification combines the Buildchain self-dogfood and `agent-hub-demo`
matrices through the exported
`@kungfu-tech/buildchain/v4-cross-platform-adopter-qualification` aggregator.
The report and aggregate explicitly grant no production, provider, release, or
stable-publication authority.

## Offline vectors

[`offline-vectors.json`](../contracts/fixtures/v4-adopter-delivery-v1/offline-vectors.json)
indexes positive driver, N-1, and archive cases plus negative selector, driver,
archive identity, bootstrap lineage, protocol version, and tampered readback
cases. Tests synthesize archives locally so extraction and identity failures do
not depend on the network.
