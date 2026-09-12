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

Generated from `architecture/workflow-taxonomy.json`. Every workflow has one canonical implementation; alternate paths and historical forwarding aliases are rejected.

Public workflows own the consumer API. Component workflows own reusable multi-job topology. Self workflows own Buildchain repository automation. Actions own execution steps; JS adapters and Rust/WASM own implementation.

Names use `public-<category>-<purpose>.yml`, `.<category>-<purpose>.yml`, and `self-<category>-<purpose>.yml`, with categories `build`, `release`, and `ops`. The primary build API and backbone use `build.yml` and `.build.yml`.

Register ownership before adding a workflow. `pnpm run check:workflows` validates source, calls, required CI integration and independent review ownership. `pnpm run generate:workflows` regenerates this catalog.

## public

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [build.yml](../.github/workflows/build.yml) | build | reusable | active | Buildchain Channel Build |
| [public-build-adopter-qualification.yml](../.github/workflows/public-build-adopter-qualification.yml) | build | reusable | active | V4 Adopter Delivery |
| [public-build-check.yml](../.github/workflows/public-build-check.yml) | build | reusable | active | Buildchain Check |
| [public-build-demo.yml](../.github/workflows/public-build-demo.yml) | build | reusable | active | Buildchain Declarative Binary Auditable Demo |
| [public-build-publication.yml](../.github/workflows/public-build-publication.yml) | build | reusable | active | Buildchain Publication Artifact |
| [public-build-stage-capsule-canary.yml](../.github/workflows/public-build-stage-capsule-canary.yml) | build | reusable | active | V4 Stage Capsule Canary |
| [public-ops-alpha-candidate-patrol.yml](../.github/workflows/public-ops-alpha-candidate-patrol.yml) | ops | reusable | active | Buildchain Dev to Alpha Candidate Patrol |
| [public-ops-bootstrap.yml](../.github/workflows/public-ops-bootstrap.yml) | ops | reusable | active | Buildchain Universal Bootstrap |
| [public-ops-dev-auto-merge.yml](../.github/workflows/public-ops-dev-auto-merge.yml) | ops | reusable | active | Dev PR Auto Merge |
| [public-ops-dev-qualification-patrol.yml](../.github/workflows/public-ops-dev-qualification-patrol.yml) | ops | reusable | active | Buildchain Dev Qualification Patrol |
| [public-ops-housekeeping.yml](../.github/workflows/public-ops-housekeeping.yml) | ops | reusable | active | Engineering Housekeeper |
| [public-ops-observed-evidence.yml](../.github/workflows/public-ops-observed-evidence.yml) | ops | reusable | active | Patrol Observed Evidence |
| [public-ops-patrol-daily.yml](../.github/workflows/public-ops-patrol-daily.yml) | ops | reusable | active | Buildchain Patrol Daily |
| [public-ops-patrol-monthly.yml](../.github/workflows/public-ops-patrol-monthly.yml) | ops | reusable | active | Buildchain Patrol Monthly |
| [public-ops-patrol-weekly.yml](../.github/workflows/public-ops-patrol-weekly.yml) | ops | reusable | active | Buildchain Patrol Weekly |
| [public-ops-patrol.yml](../.github/workflows/public-ops-patrol.yml) | ops | reusable | active | Buildchain Patrol |
| [public-ops-pipeline.yml](../.github/workflows/public-ops-pipeline.yml) | ops | reusable | active | Buildchain pipeline |
| [public-ops-release-governance.yml](../.github/workflows/public-ops-release-governance.yml) | ops | reusable | active | Release Governance Reconcile |
| [public-ops-stable-candidate-patrol.yml](../.github/workflows/public-ops-stable-candidate-patrol.yml) | ops | reusable | active | Buildchain Stable Candidate Patrol |
| [public-ops-tail-reseal.yml](../.github/workflows/public-ops-tail-reseal.yml) | ops | reusable | active | V4 Retained Candidate Tail Reseal |
| [public-ops-warrant-cancel.yml](../.github/workflows/public-ops-warrant-cancel.yml) | ops | reusable | active | Dev Delivery Warrant Queued Candidate Cancel |
| [public-ops-warrant-close.yml](../.github/workflows/public-ops-warrant-close.yml) | ops | reusable | active | Dev Delivery Warrant Close |
| [public-release-artifact-attestation.yml](../.github/workflows/public-release-artifact-attestation.yml) | release | reusable | active | Buildchain GitHub Artifact Attestation |
| [public-release-oci-compose-preview.yml](../.github/workflows/public-release-oci-compose-preview.yml) | release | reusable | active | Buildchain OCI Compose Preview |
| [public-release-paper.yml](../.github/workflows/public-release-paper.yml) | release | reusable | active | Buildchain Paper Release |
| [public-release-promote.yml](../.github/workflows/public-release-promote.yml) | release | reusable | active | Release Candidate Promote |
| [public-release-propagation.yml](../.github/workflows/public-release-propagation.yml) | release | reusable | active | Release Propagation |
| [public-release-signing-authority.yml](../.github/workflows/public-release-signing-authority.yml) | release | dispatch-service | active | Buildchain Artifact Signing Authority |
| [public-release-tail.yml](../.github/workflows/public-release-tail.yml) | release | reusable | active | Declarative Release Tail |
| [public-release-web.yml](../.github/workflows/public-release-web.yml) | release | reusable | active | Buildchain Web Surface |

## component

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [.build-demo-adapter.yml](../.github/workflows/.build-demo-adapter.yml) | build | reusable | active | Buildchain Auditable Demo |
| [.build-gate-profile.yml](../.github/workflows/.build-gate-profile.yml) | build | reusable | active | Buildchain Shifu Gate Profile |
| [.build.yml](../.github/workflows/.build.yml) | build | reusable | active | Buildchain Build |
| [.ops-git-sync.yml](../.github/workflows/.ops-git-sync.yml) | ops | reusable | active | sync remote git |
| [.ops-pipeline-delivery.yml](../.github/workflows/.ops-pipeline-delivery.yml) | ops | reusable | active | Internal pipeline delivery |
| [.release-authority.yml](../.github/workflows/.release-authority.yml) | release | reusable | active | Buildchain Sealed Publication Authority |
| [.release-binary-assets.yml](../.github/workflows/.release-binary-assets.yml) | release | reusable | active | Buildchain Binary Release Assets |
| [.release-promote.yml](../.github/workflows/.release-promote.yml) | release | reusable | active | Release Candidate Promote Advanced |

## self

| Workflow | Category | Invocation | Status | Purpose |
| --- | --- | --- | --- | --- |
| [self-build-adopter-dogfood.yml](../.github/workflows/self-build-adopter-dogfood.yml) | build | repository | active | V4 Adopter Delivery Dogfood |
| [self-build-alpha-dogfood.yml](../.github/workflows/self-build-alpha-dogfood.yml) | build | repository | active | Buildchain Alpha Self-Dogfood |
| [self-build-binary-distribution.yml](../.github/workflows/self-build-binary-distribution.yml) | build | repository | active | Binary Distribution |
| [self-build-channel-verify.yml](../.github/workflows/self-build-channel-verify.yml) | build | repository | active | Release - Verify |
| [self-build-demo-dogfood.yml](../.github/workflows/self-build-demo-dogfood.yml) | build | repository | active | Buildchain Declarative Demo Dogfood |
| [self-build-demo-media-qualification.yml](../.github/workflows/self-build-demo-media-qualification.yml) | build | repository | active | Auditable Demo Media Profile Qualification |
| [self-build-fixture.yml](../.github/workflows/self-build-fixture.yml) | build | repository | active | Build Surface Fixture |
| [self-build-public-consumer-dogfood.yml](../.github/workflows/self-build-public-consumer-dogfood.yml) | build | repository | active | V4 Public Consumer Dogfood |
| [self-build-stable-candidate-qualification.yml](../.github/workflows/self-build-stable-candidate-qualification.yml) | build | repository | active | Buildchain Stable Candidate Qualification |
| [self-build-stable-dogfood.yml](../.github/workflows/self-build-stable-dogfood.yml) | build | repository | active | Buildchain Stable Self-Dogfood |
| [self-build-verify.yml](../.github/workflows/self-build-verify.yml) | build | repository | active | Verify |
| [self-ops-bootstrap-dogfood.yml](../.github/workflows/self-ops-bootstrap-dogfood.yml) | ops | repository | active | Universal Bootstrap Train-First Self-Dogfood |
| [self-ops-dev-delivery.yml](../.github/workflows/self-ops-dev-delivery.yml) | ops | repository | active | Buildchain Dev Delivery |
| [self-ops-governance-audit.yml](../.github/workflows/self-ops-governance-audit.yml) | ops | repository | active | GitHub Governance Authority Audit |
| [self-ops-housekeeping-daily.yml](../.github/workflows/self-ops-housekeeping-daily.yml) | ops | repository | active | Engineering Housekeeper Daily |
| [self-ops-housekeeping-monthly.yml](../.github/workflows/self-ops-housekeeping-monthly.yml) | ops | repository | active | Engineering Housekeeper Monthly |
| [self-ops-housekeeping-weekly.yml](../.github/workflows/self-ops-housekeeping-weekly.yml) | ops | repository | active | Engineering Housekeeper Weekly |
| [self-ops-merge-queue.yml](../.github/workflows/self-ops-merge-queue.yml) | ops | repository | active | Dev Merge Queue Governance |
| [self-ops-patrol-daily.yml](../.github/workflows/self-ops-patrol-daily.yml) | ops | repository | active | Buildchain Dogfood Patrol Daily |
| [self-ops-patrol-monthly.yml](../.github/workflows/self-ops-patrol-monthly.yml) | ops | repository | active | Buildchain Dogfood Patrol Monthly |
| [self-ops-patrol-weekly.yml](../.github/workflows/self-ops-patrol-weekly.yml) | ops | repository | active | Buildchain Dogfood Patrol Weekly |
| [self-ops-promotion-recovery.yml](../.github/workflows/self-ops-promotion-recovery.yml) | ops | repository | active | Buildchain Ref Promotion Recovery |
| [self-ops-runner-smoke.yml](../.github/workflows/self-ops-runner-smoke.yml) | ops | repository | active | Self-hosted Runner Smoke |
| [self-ops-stable-candidate-patrol.yml](../.github/workflows/self-ops-stable-candidate-patrol.yml) | ops | repository | active | Buildchain Dogfood Stable Candidate Patrol |
| [self-release-binary-assets.yml](../.github/workflows/self-release-binary-assets.yml) | release | repository | active | Binary Release Assets |
| [self-release-line-open.yml](../.github/workflows/self-release-line-open.yml) | release | repository | active | Release Line Bootstrap |
| [self-release-next-development.yml](../.github/workflows/self-release-next-development.yml) | release | repository | active | Next Development Review |
| [self-release-npm-dry-run.yml](../.github/workflows/self-release-npm-dry-run.yml) | release | repository | active | Publish npm package |
| [self-release-promote.yml](../.github/workflows/self-release-promote.yml) | release | repository | active | Buildchain Ref Promotion |
| [self-release-rehearsal-dogfood.yml](../.github/workflows/self-release-rehearsal-dogfood.yml) | release | repository | active | V4 Publication Rehearsal Dogfood |
| [self-release-tail-dogfood.yml](../.github/workflows/self-release-tail-dogfood.yml) | release | repository | active | V4 Declarative Release Tail Dogfood |
