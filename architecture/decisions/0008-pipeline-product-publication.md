---
status: draft
period: 2026-09-13
theme: minimal-consumer-product-publication
doc_type: architecture-decision-record
source_level: local-files
confidence: medium
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-13
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-13
  visible_context: Product contract, hosted pipeline, provider adapters and local failure-path tests.
  invisible_context_boundary: No published entry qualification, production publication or external consumer adoption is established by this document.
---

# ADR 0008: Product publication stays inside the business attempt

The normal pipeline reads the existing schema-2 TOML and derives every declared
product/platform/artifact and publication target. npm packages, native archives
and Paper PDFs use the same entry and product build/verify boundary. Consumers
do not supply standard packaging, signing, publication or recovery commands.

After exact protected integration, the internal product component reserves one
provider execution in the existing attempt journal. Its repository concurrency
group serializes publication effects. Product commands run on separate hosted
jobs with read-only checkout credentials and a credential-filtered subprocess
environment. Qualification independently reads every completed platform job,
artifact coordinate, manifest and actual payload. Missing platforms, redirected
npm provider configuration and conflicting bytes are rejected.

The plan binds the protected merge source, the original channel PR source, the
selected runtime commit/tree and the defining publisher workflow SHA separately.
Stable version materialization changes only declared version fields in an
isolated Git ref. Its actual commit/tree and original protected source remain in
the Passport; this is not a tree-equivalence claim. The Rust release domain admits
the exact canonical product `apply` job and retains QUALIFY/APPLY/SETTLE ownership.

When a preceding floating channel already names a version overlay, a new overlay
retains that exact observed commit as a second Git parent. Its first parent is
the current protected source, and independent tree comparison still permits only
the declared version-file changes. This explicit merge ancestry preserves the
previous release while allowing a provider-enforced fast-forward of the channel.

The signer attests the complete qualified-product manifest with a predicate that
binds both product sources, runtime, publisher and provider execution. The
publisher verifies the GitHub/Sigstore bundle independently with the actual
defining workflow SHA and provider run source SHA. A custom predicate carries the
distinct materialized product source. This keyless signature is not an
Authenticode or macOS application signature. npm's automatic provenance is
disabled for this sealed publication path because its default workflow source
would describe the controller checkout as the product build source. The retained
custom attestation is published with the qualification and Capsule documents.

Sealed payloads and signing bundles are retained in the existing immutable
material archive before publication. Each provider operation records its intent
before effects and retains exact successful readback before moving on. npm uses
the sealed tarball, ignores lifecycle scripts and requires the registry integrity
to match. GitHub assets and exact tags are never replaced. A lost response is
reconciled from current provider state; completed packages are not republished.
The Release contains product assets requested by TOML, its Passport, qualification,
Capsule aggregate, invocation and attestation bundle.

Publication success does not finish the business attempt. Distribution moves the
npm channel and the major Git channel, with exact prior readback and no forced
Git update or npm version regression. Divergent Git channel history stops for
source reconciliation. Alpha then prepares the next development version through
an ordinary protected PR. Its original publication and receipts remain successful
while that PR waits for review, queue integration or verification. Anchored
projects wait for a protected change to their declared version authority; the
pipeline does not invent an upstream anchor. Stable publication prepares the next
patch at Alpha zero from the current protected development source. A late
completion observes already advanced development through exact protected PR
proof and cannot regress its version. Stable and Alpha retain their distinct
transition identities and the original successful publication.

Provider authorization is a one-time repository setup. Hosted npm trusted
publishing is preferred; `BUILDCHAIN_NPM_TOKEN` is an optional publisher-only
credential. Internal PR creation uses the repository's automation App
(`BUILDCHAIN_APP_CLIENT_ID` variable and `BUILDCHAIN_APP_PRIVATE_KEY` secret), or
`BUILDCHAIN_AUTOMATION_TOKEN`. It does not use `GITHUB_TOKEN` to create a PR whose
ordinary checks would be suppressed. No such credential reaches product commands.
Review and branch protections still apply to generated PRs.

The local tests cover real npm packing, native archives and PDFs, source and
version drift, independent provider inventory, signature-verifier rejection,
immutable retention, lost provider responses and protected next-development
waiting/settlement. Hosted publication and the published floating consumer entry
require separate execution evidence; passing these tests alone does not qualify
that distribution boundary.

Restricted npm products require the configured package read credential for provider
readback; anonymous 404 responses cannot qualify private-package absence. This
credential is confined to the fixed npm registry and is not supplied to product
commands. npm OIDC publication does not imply private-package read authority
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).
