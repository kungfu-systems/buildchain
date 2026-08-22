---
status: draft
period: ongoing
theme: buildchain-v4-runtime-ref-resume-authority
doc_type: contract-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-15
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-14
  invisible_context: not asserted
---

# Buildchain v4 transient runtime and resume authority

Buildchain v4 consumers keep `v4` or `v4-alpha` in tracked workflow source.
A train, authority ref, or exact SHA is transient run data, never a new
committed default. The public promotion router accepts that escape only from a
trusted `workflow_dispatch` actor with write, maintain, or admin permission.
Before heavy promotion work, it binds an exact source tree, operator reason,
dual consumer contract-lock roots, the floating-consumer policy receipt, a
clean persistence scan, and GitHub provider readbacks proving that the selected
runtime is reachable from an approved v4 ref.

The persistence scan covers tracked workflow, composite-action, JSON, TOML, and
YAML surfaces. Exact SHA, train/authority defaults, and runtime selectors hidden
through repository variables, secrets, or environment indirection reject the
run. OIDC, IAM, and other external authority references are inventoried as
metadata only; credential values are never read or written to evidence.

## Resume after a floating ref moves

A late platform failure is resumed as a new governed attempt. It is not a
GitHub failed-job rerun. The lineage keeps runtime A (the runtime that built and
sealed each reusable Stage Capsule) separate from runtime B (the authorized
runtime executing the new attempt). A Capsule is reusable only when its source
SHA, source tree, platform, policy root, build runtime, identity root, Capsule
root, and artifact digest still match. Valid unaffected platforms are restored;
only missing platforms rebuild. Stale, ambiguous, unsealed, cross-source, or
cross-policy evidence fails closed.

This deliberately does not weaken the existing Stage Capsule resume planner's
`runtime-changed` invalidation. That planner decides whether a stage may be
reused under one expected build identity. This contract instead proves that an
already sealed output built under runtime A remains the exact product input
while a distinct orchestration attempt runs under runtime B. Runtime B never
rewrites the Capsule's build identity.

Final Release Passport evidence embeds the complete authorization receipt and
the A+B resume lineage under `v4RuntimeResume`. The section binds the new
attempt, floating-ref movement, reused and rebuilt platform partition,
consumer-policy receipt, resume plan, and final public readback roots. Tampering
with either document or crossing authorization/lineage roots rejects Passport
construction and verification.

Normative files:

- `architecture/v4-runtime-ref-resume-authority.json`
- `contracts/v4-runtime-ref-resume-authority-v1.schema.json`
- `packages/core/v4-runtime-ref-resume-authority.js`
- `scripts/authorize-promotion-runtime-override.cjs`

This contract changes no v3 behavior, grants no provider mutation authority,
and stores no credential material.
