# Architecture Decision: v4 Floating Consumer Admission

Status: accepted for the v4 shadow and protected-delivery line on 2026-08-14.

Buildchain v4 consumers persist only the public `v4` and `v4-alpha` selectors.
They commit both `.buildchain/contract-lock.json` and
`.buildchain/alpha-contract-lock.json`; the selected lock binds the exact commit
behind the visible workflow selector. An exact SHA remains evidence, not a
source selector.

Every declared public v4 entrypoint runs consumer admission after immutable
source/runtime checkout and before package setup, matrix expansion, build, or
publication work. Downstream jobs depend on that admission. The scanner uses
the shared workflow YAML semantic layer and follows local composite action
manifests, so block scalar text is not mistaken for a `uses` node and nested
indirection cannot hide a selector.

The rooted receipt binds the caller repository and source SHA, invoked workflow,
selector class and channel, visible workflow-shell SHA, actual runtime SHA, both
contract-lock roots, and the policy/scanner/source-scan roots. A trusted manual
train or SHA may replace only the actual runtime coordinate; it does not rewrite
the tracked selector or the lock-to-shell binding.

Release-candidate Passport construction requires the receipt for v4 runtimes.
Promotion independently certifies it, and final Release Passport construction
requires that certification to match the caller source and actual runtime.
Missing, rejected, stale, root-mismatched, or old-runtime evidence fails closed.

The normative machine declaration is
[`v4-floating-consumer-policy.json`](v4-floating-consumer-policy.json). v3
behavior, provider effects, credentials, and production mutation authority are
outside this decision.
