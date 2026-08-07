---
status: accepted
period: 2026-08-08
theme: release-local-constructibility
doc_type: architecture-decision-record
source_level: local-files + protected-git-evidence
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-08
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-08
  visible_context: Buildchain release-tail core, provider adapters, CLI, Actions, generators, workflows, configuration, and tests.
  invisible_context_boundary: No credentials, provider secrets, private logs, unpublished artifacts, or external publication state were read.
---

# ADR 0001: Release Local Constructibility and Runner Independence

## Status

Accepted. This decision is normative for every Buildchain-generated repository
and every Buildchain-hosted release-tail wrapper.

## Decision

Every non-external release behavior is locally constructible and testable from
an explicit content-addressed capsule; no semantic path depends on GitHub runner
state.

The capsule binds candidate files, the release-tail declaration, policy roots,
the Release Passport, initial transaction state, provider bindings, declared
environment, portable platform policy, unavoidable external effects, and any
recorded provider observations. Buildchain verifies those bindings before it
compiles or executes the existing release-tail transaction core.

Local simulation, recorded replay, and hosted provider execution call the same
public `executePublicationRehearsal` function and therefore the same
`compileReleaseTailDeclaration`, `validateReleaseTailTransaction`, and
`executeReleaseTailTransaction` implementation. Simulation and replay evidence
are explicitly non-authoritative and never establish registry acceptance,
publication, activation, notarization, attestation, or public readback.

The hosted wrapper may contribute only:

- credentials supplied through declared Action secret inputs;
- transport clients for the enumerated GitHub and HTTPS provider effects; and
- unavoidable external provider responses, captured as a rooted transcript.

It may not contribute undeclared `GITHUB_*` values, an implicit workspace,
runner filesystem layout, runner image behavior, platform-specific semantics,
job outputs, executable repository hooks, or a parallel transaction authority.

## Fail-closed rules

The runtime rejects unknown capsule fields, root drift, missing or symbolic
files, absolute or ambiguous capsule paths, undeclared environment keys,
platform assumptions, unenumerated provider effects, transaction/declaration
drift, exhausted replay observations, and adapter-set drift with stable
machine-readable diagnostic codes and roots.

## Required projections

Fresh init, Paper scaffold, Paper migration, and Paper fleet update must project
this ADR path, its invariant, the capsule contract, and the exact local command
into `.buildchain/buildchain.toml`, the managed `AGENTS.md` section, and
`.github/workflows/publication-rehearsal.yml`. Drift in any projection is a
generation or validation failure.

## Consequences

Hosted retries are reserved for external uncertainty. Deterministic failures
must be reproduced from the retained capsule and roots locally before another
hosted attempt. A hosted green run remains provider evidence, not permission to
weaken Passport, authentication, public readback, protected delivery, or
independent review.
