---
status: draft
period: ongoing
theme: buildchain-versioning
doc_type: policy
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-01
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-30
  invisible_context_boundary: Live release and provider state must be verified independently.
---

# Buildchain Versioning

Buildchain uses semantic version lines to describe public contracts, not only
code size. A release can be small in diff size and still open a new minor line
when it adds a durable surface that consumers, workflows, or agents can depend
on.

## Lines

| Line  | Meaning                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch | Compatible fix, hardening, documentation correction, or implementation repair inside an existing surface.                                                                    |
| Minor | New compatible welded surface: reusable workflow output, CLI command family, config protocol, published subpath, evidence file, runner contract, or agent-readable artifact. |
| Major | Breaking semantic change, removed stable surface, changed branch/tag governance, or incompatible protocol rewrite.                                                           |

Kungfu minor lines are long-lived trains. `v3.0`, `v3.1`, and `v3.2` can each
receive many patch releases. The major ref, such as `v3`, points at the
selected stable major entrypoint; the minor ref, such as `v3.2`, points at the
latest stable production patch for that minor line.

## Welded Surfaces

These surfaces are classified independently; the final release impact is the
highest impact across the affected registered surfaces:

- reusable workflow inputs, outputs, and artifact contracts;
- public CLI command families and their machine-readable JSON shapes;
- public npm exports such as `@kungfu-tech/buildchain/logging`;
- config protocols such as `buildchain.toml`;
- release governance state machines and protected ref semantics;
- release evidence contracts such as passport, artifact evidence, impact
  ledger, and agent index files;
- binary distribution shapes that users can install or automate against.

For each surface:

- content, documentation, or implementation-only work that does not touch a
  registered surface is patch;
- additive fields, new commands, new exports, new evidence sections, or new
  registered surfaces are minor;
- removals, incompatible renames, changed meanings, newly required fields,
  weakened trust gates, or changed ref flow are major.

The release passport records this as `surfaceImpacts[]` plus
`versionImpact.final`. The final impact must equal the highest surface impact,
so an agent cannot silently label a release patch when one machine surface needs
minor review.

`surfaceImpacts[]` is mandatory for production release passports (`release/*`)
and major publish-gate passports. Alpha, local, and legacy passport contexts
keep the field optional so temporary validation can proceed without pretending
to be a production release decision.

Example: a KFD document such as KFD-2 is content and remains patch, but adding a
`kind` field to the machine-consumed KFD `registry.json` is an additive change
to the `kfd-registry-schema` surface and therefore requires minor-impact
review. This avoids both false shortcuts: "new KFD means minor" and "all KFD
repository changes are patch".

## Decision Log

| Date       | Action       | Line    | Faces                                                                                                                                                                        | Class    | Rationale                                                                                                                                                                                                                                                                                                                              | PR    |
| ---------- | ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 2026-08-14 | extend-minor | `v3.0`  | source-qualification-proof-v2, source-proof-reuse-decision, reusable-check-workflow                                                                                           | additive | Add opt-in exact accepted source-proof reuse for merge groups, binding source, base, patch, runtime, plan, policy, closure, dependency, required-context, producer receipt, and caller run. Any missing or changed predicate fails closed to the existing full source lifecycle, which remains the default.                              |       |
| 2026-08-11 | extend-minor | `v3.0`  | provisional-delivery-warrant, qualified-delivery-warrant, native-qualification-proof, native-proof-reuse-decision, generated-native-delivery-workflow                         | additive | Reserve protected-dev order after exact source acceptance and approval, then require an atomic native-proof-bound qualification before merge-queue admission. Reuse is limited to stable semantic source, closure, dependencies, and toolchain with a fully attributed disjoint base delta; overlap and uncertainty fail closed to revalidation. |       |
| 2026-08-12 | extend-minor | `v3.0`  | bounded-qualification-lease, exclusive-landing-warrant, dev-delivery-authority-v2                                                                                               | additive | Add an explicit opt-in v2 state that permits bounded qualification-only leases while retaining one exclusive merge-group Landing Warrant. The v1 single-flight Warrant state and commands remain the byte- and behavior-compatible default.                                                                       |       |
| 2026-08-12 | extend-minor | `v3.0`  | native-qualification-proof-v2, native-proof-base-delta, idempotent-native-proof-resume                                                                                          | additive | Bind native proof to the execution environment and a rooted complete Dev-delta/rename attribution, persist completed proof before final classification, and make duplicate qualified-controller dispatch an effect-free replay. Legacy v1 proof remains verifiable but cannot be reused without the v2 environment binding. |       |
| 2026-08-11 | extend-minor | `v3.0`  | release-blocker-repair-contract, release-blocker-priority-claim, release-train-node-export, dev-delivery-warrant-node-export, next-development-transition, next-development-projection | additive | Add rooted successor candidate generations on a frozen Release Cut, exact semantic patch identity across cut and Dev landings, publication blocking through conflict or mismatch, a narrow non-preemptive Warrant blocker lane, and a separate rooted transition that preserves completed Alpha success while the following development version is materialized. |       |
| 2026-08-10 | extend-minor | `v3.0`  | release-cut-contract, release-train-state-machine, release-train-node-export                                                                                                 | additive | Add a provider-neutral rooted Release Cut and idempotent Release Train state contract that freezes candidate, tree, Alpha base, runtime, generation, and authority while treating later Dev movement as observation rather than implicit supersession.                                                                                 |       |
| 2026-08-05 | extend-minor | `v3.0`  | auditable-demo-scenario, auditable-demo-capture, auditable-demo-adapter                                                                                                      | additive | Add an opt-in deterministic readable-playback declaration that preserves captured terminal payloads and order while normalizing only presentation timing; omitted playback continues to use observed PTY timestamps, and existing composition modes remain unchanged.                                                                  |       |
| 2026-08-04 | extend-minor | `v3.0`  | dev-delivery-warrant-queue, source-qualification-proof, integration-delivery-proof, dev-delivery-cli, reusable-dev-delivery-workflows                                        | additive | Add durable fair and fenced protected-dev scheduling plus split source/integration proof contracts. Existing PR admission remains available through explicit `off` and `shadow` rollout modes; no existing command, export, or release flow is removed.                                                                                |       |
| 2026-08-01 | extend-minor | `v3.0`  | cli-reference-registry, node-api-symbol-registry, golden-path-manual                                                                                                         | additive | Add generated, drift-checked CLI and Node API reference registries to the public site bundle, plus a package-tested first-user Golden Path; existing command execution and import semantics remain unchanged.                                                                                                                          |       |
| 2026-07-31 | extend-minor | `v3.0`  | auditable-demo-workflow, auditable-demo-media-profile, auditable-demo-media-receipt                                                                                          | additive | Add an opt-in responsive profile that binds source-resolution and exact 1280x720 MP4/WebM/GIF renditions to one Gate and receipt while rejecting upscales, aspect-ratio drift, and profile changes between Gate-only and full-render paths.                                                                                            |       |
| 2026-07-31 | extend-minor | `v3.0`  | release-candidate-family-evidence, release-passport-evidence-attachment, promotion-action, release-passport-cli                                                              | additive | Restore all-ref v2 parity for optional Initiative-family candidate binding and typed product-owned release evidence attachments while retaining Kungfu native Family State authority and the newer v3 post-activation released-evidence stage.                                                                                         | #2089 |
| 2026-07-30 | extend-minor | `v3.0`  | reusable-build-workflow, observed-evidence-bundle, release-passport-json-reader, web-surface-release-governance                                                              | additive | Add bounded artifact compression and remote-read controls plus transactional derived evidence projections while repairing release-PR runtime handoff so production remains protected-main-only.                                                                                                                                        |       |
| 2026-07-29 | extend-minor | `v3.0`  | artifact-signing-config, apple-developer-id-authority, artifact-signing-evidence                                                                                             | additive | Extend the consumer-neutral signing declaration to macOS compound archives, including nested wheel Mach-O signing, PEP 427 RECORD repair, safe archive reconstruction, and whole-product notarization under the same protected authority.                                                                                              |       |
| 2026-07-28 | extend-minor | `v3.0`  | auditable-demo-workflow, auditable-demo-media-profile, auditable-demo-media-receipt                                                                                          | additive | Add opt-in archive, web-delivery, and site-hero profiles; independently bind codec, container, audio, layout, byte-budget, role, and fast-start facts into a v2 media receipt while preserving the existing archive default.                                                                                                           |       |
| 2026-07-26 | extend-minor | `v3.0`  | auditable-demo-workflow, auditable-demo-evidence                                                                                                                             | additive | Forward-port the consumer-neutral reusable Gate that binds exact same-run GitHub Artifacts to checked-in adapters and immutable renderer evidence, with optional media rendering only from the exact passing Gate bundle.                                                                                                              | #1862 |
| 2026-07-23 | extend-minor | `v2.14` | credential-island-macos-input, protected-signer-job, macos-signing-evidence, action-subpaths                                                                                 | additive | The reusable build surface can seal an exact source-bound macOS app and hand it to a protected caller environment, where an immutable Buildchain action signs, notarizes, staples, Gatekeeper-assesses, and returns an auditable additional release-candidate platform without exposing credentials to consumer lifecycle jobs.        |       |
| 2026-07-20 | extend-minor | `v2.14` | anchored-derived-version-material, build-controller-evidence, release-passport, package-subpaths, release-propagation-controller                                             | additive | Anchored/manual consumers can declare derived version witnesses that Buildchain regenerates and verifies before heavy builds, binds to exact alpha/release trees and passports, and admits during protected promotion; propagation receipts now model their existing optional consumer stages.                                         |       |
| 2026-07-17 | extend-minor | `v2.14` | merge-queue-config, release-line-governance-inheritance                                                                                                                      | additive | Buildchain config can explicitly enable, inherit, or disable exact dev-channel merge queues, and release-line bootstrap reconciles the declared or inherited policy before moving the repository default branch.                                                                                                                       |       |
| 2026-07-16 | open-minor   | `v2.14` | dev-merge-queue-governance                                                                                                                                                   | additive | The public CLI adds a dry-run-first, idempotent merge-queue governance command that verifies required workflow event compatibility before applying an exact dev-channel ruleset and removing the strict up-to-date race.                                                                                                               |       |
| 2026-07-15 | open-minor   | `v2.13` | artifact-verification-envelope, package-subpaths                                                                                                                             | additive | The public envelope seals exact artifact, provenance, identity, lifecycle, revocation, and existing KFD assessment roots into one consumer-ready KFX admission input, with a dedicated Node API export and fail-closed verifier.                                                                                                       |       |
| 2026-07-11 | open-minor   | `v2.12` | channel-build-router, channel-selection-protocol                                                                                                                             | additive | The public `build.yml` reusable workflow lets consumers declare one build job while Buildchain selects generic major alpha for development/prerelease intent and stable major for production release intent, with explicit overrides, separate locks, and fail-closed ambiguity handling.                                              |       |
| 2026-07-08 | open-minor   | `v2.9`  | build-facts-contract                                                                                                                                                         | additive | Build Facts add a public CLI command family, Node API export, config protocol, module/product fact contracts, release-passport evidence section, and Kungfu legacy buildinfo projection from the same source facts.                                                                                                                    |       |
| 2026-07-06 | open-minor   | `v2.8`  | kfd-1-contract-world-release-gate, kfd-2-release-trust-passport-audit, kfd-3-collaboration-interface-trust-proof, publish-source-lock-enforcement, required-check-protection | additive | KFD release gates add KFD-1 self contract verification, KFD-2 public release trust claim audit, KFD-3 collaboration-interface trust proofs, publish-side source-lock enforcement for promote-only wrappers, and protected channel required checks repaired to bind GitHub Actions check runs instead of legacy commit status contexts. |       |
| 2026-07-04 | open-minor   | `v2.5`  | scheduled-integration-governance                                                                                                                                             | additive | Scheduled integration governance adds scheduled feature-branch discovery, conflict-free integration, reporting, and agent-visible governance automation for dev-line maintenance.                                                                                                                                                      |       |
| 2026-07-03 | open-minor   | `v2.4`  | infra-contract-lifecycle                                                                                                                                                     | additive | Infra contract lifecycle adds the provider-neutral `infra-contract` CLI command family, project type, adapter capability contract, lifecycle evidence bundle, propagation evidence, CI evidence mode, and consumer-facing contract artifacts.                                                                                          |       |
| 2026-07-02 | open-minor   | `v2.3`  | web-surface-host-mapping                                                                                                                                                     | additive | Web surface host mapping adds first-class multi-host surface bindings, reusable workflow URL outputs, per-surface deployment overrides, and an agent-readable fixture contract.                                                                                                                                                        |       |
| 2026-07-02 | open-minor   | `v2.2`  | release-passport, binary-distribution                                                                                                                                        | additive | Release passport and binary distribution add agent-readable release passport files, artifact evidence, impact ledger, agent index, GitHub Release collection and verification commands, and standalone binary assets.                                                                                                                  |       |
| 2026-07-02 | open-minor   | `v2.1`  | logging-sdk, cli-observability, package-subpaths                                                                                                                             | additive | Buildchain toolkit observability adds the public logging SDK, CLI observability commands, and package subpaths that consumers can import.                                                                                                                                                                                              |       |

## Runner Policy

The `v2.2` binary distribution lane uses GitHub-hosted runners for production
assets because that is the easiest release path for external users to reproduce:

- `ubuntu-24.04`
- `macos-latest`
- `windows-2022`

Self-hosted runners remain compatibility fixtures. They prove Buildchain's
protocol does not depend on GitHub-hosted images, but they do not define the
public binary distribution path.
