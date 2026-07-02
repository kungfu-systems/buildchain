# Versioning — welded surfaces and the decision log

How this repository decides patch, minor, and major. The rule is
[KFD-1](https://github.com/kungfu-systems/kfd/blob/dev/v1/v1.0/decisions/kfd-0001-release-versioning.md):
every change is classified against the welded-surface register below —
breaking a registered surface forces a major, additively evolving one or
adding one opens a minor, and a change that touches no registered surface is a
patch regardless of size. This document is the living register and decision
log; it does not restate the rule. For how lines are opened and promoted, see
[`release-governance.md`](release-governance.md) and
[`release-flow.md`](release-flow.md).

## Welded-surface register

| ID | Surface | Kind | Where it is specified |
|---|---|---|---|
| `toml-schema` | `buildchain.toml` configuration schema (including the `schema = 1` fail-closed gate) | integration | [`lifecycle-protocol.md`](lifecycle-protocol.md) |
| `action-contracts` | input/output contracts of `validate-config`, `run-lifecycle`, `promote-buildchain-ref` | integration | action READMEs under `actions/` |
| `workflow-contracts` | reusable workflow inputs/outputs (`.build.yml`, `.web-surface.yml`) | integration | [`reusable-build-surface.md`](reusable-build-surface.md), [`web-surface-deployments.md`](web-surface-deployments.md) |
| `channel-ontology` | channel branch and tag semantics (dev → alpha → release → publish-gate; exact vs floating refs) | integration | [`release-governance.md`](release-governance.md) |
| `publish-evidence` | publish transaction state and evidence schemas (including `refs/heads/buildchain/release-state/*`) | integration + cross-time | [`publish-transaction.md`](publish-transaction.md) |

Surfaces planned by the toolkit line (the structured event protocol and the
importable SDK subpaths) enter this register when they land; per KFD-1 that
landing opens a minor.

A surface is registered when consumers bind to it at integration time without
runtime negotiation, or when its outputs remain depended on after the run.
Register changes are maintainer decisions and are logged below.

## Decision log

Line openings (minor/major), register changes, and deprecations are recorded
here, newest first. Patches are intentionally absent — silence means no
registered surface was touched.

| Date | Action | Line | Faces | Class | Rationale | PR |
|---|---|---|---|---|---|---|
| 2026-07-02 | register | — | toml-schema, action-contracts, workflow-contracts, channel-ontology, publish-evidence | additive | Initial register established on adopting KFD-1 | — |
