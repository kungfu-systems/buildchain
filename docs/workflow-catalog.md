---
status: active
period: ongoing
theme: workflow-taxonomy
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-09
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-09
  visible_context: Canonical Buildchain workflow ownership and source files
  invisible_context_boundary: No private credentials or unpublished consumer state inspected
---

# Workflow catalog

Generated from `architecture/workflow-taxonomy.json`. Every workflow has one canonical implementation. Historical entry contracts declared in an optional `architecture/consumer-upgrade.json` registry must match their generated canonical implementations byte-for-byte, including job contexts, inputs, outputs, permissions and publisher identities.

The two public workflows own normal pipeline execution and exact-attempt recovery. Component workflows are internal runtime implementation, including once-only setup and the dispatch signing service; consumers do not wire these components. Self workflows are the generated consumer pair. Actions own execution steps; JS adapters and Rust/WASM own implementation.

Names use `public-ops-pipeline.yml`, `public-ops-recover.yml`, internal `.<category>-<purpose>.yml`, and the generated self callers `buildchain.yml` and `buildchain-recover.yml`. Categories are `build`, `release`, and `ops`; the internal build engine retains `.build.yml`.

Register ownership before adding a workflow. `pnpm run check:workflows` validates source, calls, required CI integration and independent review ownership. `pnpm run generate:workflows` regenerates this catalog.

## public

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [public-ops-pipeline.yml](../.github/workflows/public-ops-pipeline.yml) | ops | reusable | active | Buildchain pipeline |
| [public-ops-recover.yml](../.github/workflows/public-ops-recover.yml) | ops | reusable | active | Buildchain recovery |

## component

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [.build-adopter-qualification.yml](../.github/workflows/.build-adopter-qualification.yml) | build | reusable | active | V4 Adopter Delivery |
| [.build-candidate.yml](../.github/workflows/.build-candidate.yml) | build | reusable | active | Buildchain Channel Build |
| [.build-check.yml](../.github/workflows/.build-check.yml) | build | reusable | active | Buildchain Check |
| [.build-demo-adapter.yml](../.github/workflows/.build-demo-adapter.yml) | build | reusable | active | Buildchain Auditable Demo |
| [.build-demo.yml](../.github/workflows/.build-demo.yml) | build | reusable | active | Buildchain Declarative Binary Auditable Demo |
| [.build-gate-profile.yml](../.github/workflows/.build-gate-profile.yml) | build | reusable | active | Buildchain Shifu Gate Profile |
| [.build-publication.yml](../.github/workflows/.build-publication.yml) | build | reusable | active | Buildchain Publication Artifact |
| [.build-stage-capsule-canary.yml](../.github/workflows/.build-stage-capsule-canary.yml) | build | reusable | active | V4 Stage Capsule Canary |
| [.build.yml](../.github/workflows/.build.yml) | build | reusable | active | Buildchain Build |
| [.ops-alpha-candidate-patrol.yml](../.github/workflows/.ops-alpha-candidate-patrol.yml) | ops | reusable | active | Buildchain Dev to Alpha Candidate Patrol |
| [.ops-bootstrap.yml](../.github/workflows/.ops-bootstrap.yml) | ops | reusable | active | Buildchain Universal Bootstrap |
| [.ops-dev-auto-merge.yml](../.github/workflows/.ops-dev-auto-merge.yml) | ops | reusable | active | Dev PR Auto Merge |
| [.ops-dev-qualification-patrol.yml](../.github/workflows/.ops-dev-qualification-patrol.yml) | ops | reusable | active | Buildchain Dev Qualification Patrol |
| [.ops-git-sync.yml](../.github/workflows/.ops-git-sync.yml) | ops | reusable | active | sync remote git |
| [.ops-housekeeping.yml](../.github/workflows/.ops-housekeeping.yml) | ops | reusable | active | Engineering Housekeeper |
| [.ops-observed-evidence.yml](../.github/workflows/.ops-observed-evidence.yml) | ops | reusable | active | Patrol Observed Evidence |
| [.ops-patrol-daily.yml](../.github/workflows/.ops-patrol-daily.yml) | ops | reusable | active | Buildchain Patrol Daily |
| [.ops-patrol-monthly.yml](../.github/workflows/.ops-patrol-monthly.yml) | ops | reusable | active | Buildchain Patrol Monthly |
| [.ops-patrol-weekly.yml](../.github/workflows/.ops-patrol-weekly.yml) | ops | reusable | active | Buildchain Patrol Weekly |
| [.ops-patrol.yml](../.github/workflows/.ops-patrol.yml) | ops | reusable | active | Buildchain Patrol |
| [.ops-pipeline-delivery.yml](../.github/workflows/.ops-pipeline-delivery.yml) | ops | reusable | active | Internal pipeline delivery |
| [.ops-pipeline-execute.yml](../.github/workflows/.ops-pipeline-execute.yml) | ops | reusable | active | Internal pipeline execution |
| [.ops-release-governance.yml](../.github/workflows/.ops-release-governance.yml) | ops | reusable | active | Release Governance Reconcile |
| [.ops-stable-candidate-patrol.yml](../.github/workflows/.ops-stable-candidate-patrol.yml) | ops | reusable | active | Buildchain Stable Candidate Patrol |
| [.ops-tail-reseal.yml](../.github/workflows/.ops-tail-reseal.yml) | ops | reusable | active | V4 Retained Candidate Tail Reseal |
| [.ops-warrant-cancel.yml](../.github/workflows/.ops-warrant-cancel.yml) | ops | reusable | active | Dev Delivery Warrant Queued Candidate Cancel |
| [.ops-warrant-close.yml](../.github/workflows/.ops-warrant-close.yml) | ops | reusable | active | Dev Delivery Warrant Close |
| [.release-artifact-attestation.yml](../.github/workflows/.release-artifact-attestation.yml) | release | reusable | active | Buildchain GitHub Artifact Attestation |
| [.release-authority.yml](../.github/workflows/.release-authority.yml) | release | reusable | active | Buildchain Sealed Publication Authority |
| [.release-binary-assets.yml](../.github/workflows/.release-binary-assets.yml) | release | reusable | active | Buildchain Binary Release Assets |
| [.release-candidate-promote.yml](../.github/workflows/.release-candidate-promote.yml) | release | reusable | active | Release Candidate Promote |
| [.release-oci-compose-preview.yml](../.github/workflows/.release-oci-compose-preview.yml) | release | reusable | active | Buildchain OCI Compose Preview |
| [.release-paper.yml](../.github/workflows/.release-paper.yml) | release | reusable | active | Buildchain Paper Release |
| [.release-pipeline-products.yml](../.github/workflows/.release-pipeline-products.yml) | release | reusable | active | Internal pipeline product publication |
| [.release-pipeline-version.yml](../.github/workflows/.release-pipeline-version.yml) | release | reusable | active | Internal pipeline version preparation |
| [.release-promote.yml](../.github/workflows/.release-promote.yml) | release | reusable | active | Release Candidate Promote Advanced |
| [.release-propagation.yml](../.github/workflows/.release-propagation.yml) | release | reusable | active | Release Propagation |
| [.release-signing-authority.yml](../.github/workflows/.release-signing-authority.yml) | release | dispatch-service | active | Buildchain Artifact Signing Authority |
| [.release-tail.yml](../.github/workflows/.release-tail.yml) | release | reusable | active | Declarative Release Tail |
| [.release-web.yml](../.github/workflows/.release-web.yml) | release | reusable | active | Buildchain Web Surface |

## self

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [buildchain-recover.yml](../.github/workflows/buildchain-recover.yml) | ops | repository | active | Buildchain recovery |
| [buildchain.yml](../.github/workflows/buildchain.yml) | ops | repository | active | Buildchain pipeline |
