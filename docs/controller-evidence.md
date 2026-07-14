---
status: draft
period: ongoing
theme: buildchain-controller-evidence
doc_type: analysis
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-14
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-14
  boundary: Based on repository source and tests; no claim about unobserved downstream runs.
---

# Controller Evidence

Buildchain controller evidence records what a reusable workflow intended to do
and what it actually completed. It is a project-independent envelope around
Buildchain orchestration; it does not replace a consumer project's own policy,
Gate registry, or domain receipts.

The machine-readable entrypoint is
`dist/site/controller-registry.json`. The Node API is exported as
`@kungfu-tech/buildchain/controller-evidence`.

## Public controller inventory

The first versioned inventory contains:

- source check;
- lifecycle build and channel routing;
- the Shifu Gate profile envelope;
- web-surface build/deploy orchestration;
- publication artifact and paper release;
- release-candidate promotion;
- release propagation.

Patrol and repository-maintenance workflows are not controllers. A controller
descriptor declares its workflow, version, input classifications, expected
stages, capabilities, evidence kinds, and a deterministic descriptor digest.

## Plan contract

A `buildchain.controller-evidence/v1` plan binds:

- the controller id, version, workflow path, and descriptor digest;
- the exact consumer repository and 40-character source SHA;
- the requested Buildchain ref, exact runtime SHA, and runtime contract digest;
- normalized inputs;
- expected stages, capabilities, and evidence kinds.

Inputs use one of four policies:

- `included` for safe scalar values;
- `digest-only` for commands, structured values, runner selection, paths, role
  identifiers, registries, mirrors, and other environment-shaped values;
- `redacted` for workflow secrets and token/private-key shaped fields;
- `unsupported` for a declared input that must fail closed when provided.

Redacted inputs carry no value, digest, or presence bit. Included path-like
inputs reject absolute runner paths. Undeclared inputs fail plan creation.

## Receipt and aggregation

A receipt binds back to the plan digest and repeats the source and runtime
identities. Every declared stage is recorded as `passed`, `failed`, `skipped`,
`cancelled`, or `missing`; the receipt status is `passed`, `failed`, `skipped`,
or `partial`. Evidence is represented by kind and SHA-256 digest, with an
optional artifact name.

Reusable workflows expose these outputs:

- `controller-plan-artifact`, `controller-plan-json`, and
  `controller-plan-digest`;
- `controller-receipt-artifact`, `controller-receipt-json`,
  `controller-receipt-digest`, and `controller-receipt-status`.

Final aggregation uses `always()`. A required missing stage, required missing
evidence, invalid digest, source/runtime mismatch, or missing receipt cannot be
reported as qualifying green. `aggregateControllerReceipts()` reports an
explicit `receipt-missing` status when a plan has no receipt.

## Shifu boundary

The Shifu profile controller is an envelope only. Its controller receipt
references the digest and status of `buildchain.shifu-gate-aggregate/v1`; it
does not copy project Gate identifiers, Gate semantics, registry contents, or
per-Gate results into Buildchain's generic controller contract.

## Release Passport references

Release-candidate and final Release Passport documents may carry compact
`controllerReceipts[]` references. Each reference contains the controller id,
plan and receipt digests, source and runtime SHAs, status, and artifact name.
The passport validates those identities; it never invents a controller receipt
from a successful job conclusion.

The PR-stage lifecycle build creates its qualifying receipt before the
release-candidate passport. Promotion validates that passport and preserves the
same references in the final Release Passport, closing the build-to-publish
evidence chain.

## Train validation

An unreleased contract should be tested through a temporary Buildchain train
ref and an exact downstream consumer source SHA. The downstream run should
retain the plan artifact, receipt artifact, workflow outputs, and Release
Passport or release-candidate reference. Promote to an official alpha or stable
channel only after those identities and digests agree.
