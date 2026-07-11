---
status: draft
period: 2026-07-10
theme: buildchain-consolidation
doc_type: engineering-retrospective
source_level: live-system-check
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-11
---

# Buildchain Consolidation Retrospective — 2026-07-10

This record captures a time-bounded engineering review of Buildchain after a
period of rapid v2 capability growth. It is a handoff document, not a release
policy by itself. Future changes must still follow the current contribution,
release-governance, and compatibility rules.

## Baseline

The review used the following baseline:

- repository: `kungfu-systems/buildchain`;
- default branch: `dev/v2/v2.11`;
- reviewed commit: `7e95cb12827ef38d802a6adb2e25ae2ae9f2bf1b`;
- latest stable release at review time: `v2.11.9`;
- local branch and `origin/dev/v2/v2.11` were equal at the reviewed commit;
- the latest sampled `Verify`, Binary Distribution, Build Surface Fixture, and
  Release Verify runs were successful.

The repository is functionally active and well tested in CI. The main risk is
now consolidation debt: release evidence precision, release-transaction
amplification, maintainability of large implementation surfaces, and lifecycle
governance for an expanding public contract.

## Evidence Snapshot

These are observed facts, not estimates:

- From 2026-07-03 through the review snapshot, GitHub exposed 189 Buildchain
  releases: 113 stable releases and 76 prereleases.
- The merged pull request query reached its 500-result limit for the same
  period. In that sample, 443 titles matched promotion, release, version-state,
  preparation, or state-synchronization work.
- The generated public registries exposed 74 CLI command entries, 23 Node API
  exports, 37 workflow entries, and 4 active actions.
- The largest hand-maintained implementation and test surfaces included:
  - `tests/promote-buildchain-ref.test.mjs`: 7,390 lines;
  - `actions/promote-buildchain-ref/lib.js`: 5,147 lines;
  - `scripts/web-surface-core.mjs`: 2,011 lines;
  - `packages/core/release-passport.js`: 1,974 lines;
  - `bin/buildchain.mjs`: 1,865 lines;
  - `.github/workflows/.web-surface.yml`: 1,516 lines;
  - `.github/workflows/.build.yml`: 1,480 lines.
- Remote refs included 256 durable `buildchain/release-state/*` refs and 123
  `buildchain/version-state/*` refs. Durable release-state refs are audit
  records and are not cleanup candidates merely because they are numerous.

## P0 Findings

### 1. Release impact evidence is not derived from the release

At the reviewed commit,
`.github/workflows/buildchain-ref-promotion.yml` passed a static
`release-passport-impact-json` payload that still described a Buildchain v2.10
patch release. The public `v2.11.9/impact.json` consequently described v2.10
changes, reported an `unknown` classification, and supplied no release impact
summary.

This is a correctness failure in Buildchain's primary trust product. Release
impact must be an input or output of the release candidate/version-state
transaction, not a long-lived literal in workflow YAML.

Acceptance criteria:

1. The impact record is generated from a version-bound source carried by the
   release candidate or version-state commit.
2. Stable promotion fails before publication when the impact version does not
   match the target version, the classification is unknown, or the summary is
   missing.
3. Tests prove that a prior minor line's impact cannot be reused by the current
   release line.
4. The next stable release publishes an impact record whose version, summary,
   and surface changes match that release.

### 2. Promotion transactions are not serialized

The promotion workflow had no top-level concurrency group. Recent failed runs
included non-fast-forward ref updates while multiple promotion transactions
were moving release state. A separate failure reached version verification
before discovering that `dist/site/publication-registry.json` changed outside
the accepted version-state set.

Relevant failed runs at review time:

- <https://github.com/kungfu-systems/buildchain/actions/runs/29060772647>
- <https://github.com/kungfu-systems/buildchain/actions/runs/29059315116>
- <https://github.com/kungfu-systems/buildchain/actions/runs/29029391212>

Acceptance criteria:

1. Promotion transactions are queued with `cancel-in-progress: false`, initially
   globally or by a proven release-line key.
2. A queued transaction revalidates its source and target heads immediately
   before writing refs.
3. A transaction superseded by a newer compatible promotion exits as an
   auditable no-op instead of failing late.
4. All version-derived generated outputs are checked before the expensive
   release-candidate and publish stages.
5. Concurrency tests reproduce two same-line promotions and prove that no
   non-fast-forward update reaches the publication boundary.

### 3. Stable release throughput amplifies small changes

Buildchain already has train and alpha mechanisms for fast validation. The
observed stable release and promotion-PR volume indicates that stable publication
is also being used as a high-frequency debugging loop. That makes exact release
review harder and creates repeated state, tag, evidence, and branch work for
small changes.

Proposed direction, pending a maintainer policy decision:

- keep train and alpha fast;
- require named consumer canaries and a soak interval before stable promotion;
- batch compatible fixes into one stable patch window;
- prevent a stable release when no new product or contract diff exists;
- report product PRs, generated promotion PRs, retries, and stable releases as
  separate operational metrics.

## P1 Consolidation

### Internal module boundaries

Split large files without changing the public package, CLI, workflow, or action
contracts first:

- promotion policy and parsing;
- GitHub ref/check/PR adapters;
- version-state planning and verification;
- durable publish transactions;
- release passport and impact evidence;
- CLI handlers grouped by release, KFD, facts, diagnostics, and web surfaces.

Long reusable workflow files should retain their public inputs and outputs while
moving procedural logic into versioned JavaScript modules with unit tests.

### Public surface lifecycle

The registries already enumerate public capabilities. Extend that fact source
with ownership and lifecycle metadata:

- owner;
- maturity;
- introduced version;
- compatibility promise;
- deprecated version and replacement;
- sunset condition.

New public commands, workflows, actions, or package exports should identify an
existing capability group and justify why the existing surface cannot carry the
new behavior.

### Documentation and dependency hygiene

The review found version-specific examples that still name older v2.2/v2.3
lines and an action inventory that omitted `report-buildchain-issue`. Replace
current-line literals with placeholders or generated facts when the number is
not semantically part of the example. Derive public action/workflow inventories
from the existing machine-readable registry and test the corresponding docs.

The root package also declared `vitest`, `prettier`, and `@types/node` without
tracked configuration or source usage. Either make formatting/static checking
part of the done-check for hand-maintained sources or remove unused dependencies.

## P2 Repository Hygiene

Repository cleanup must classify refs before deletion:

- retain immutable exact tags and durable `buildchain/release-state/*` audit
  refs;
- retain protected dev/alpha/release channels;
- retain train refs only for their documented validation and rollback window;
- identify merged or closed `buildchain/version-state/*` and ordinary working
  branches, then delete them only after ancestry and open-PR checks;
- publish the retention rule through Buildchain patrol rather than relying on
  manual cleanup.

## Recommended First Implementation Slice

The first follow-up should stay deliberately narrow:

1. replace the static impact payload with a version-bound impact source;
2. add promotion serialization and stale-transaction no-op behavior;
3. move generated-output drift checks ahead of expensive promotion work;
4. add regression tests for all three behaviors;
5. publish one corrected alpha and one corrected stable release, then verify the
   public evidence assets.

Do not combine this slice with module reorganization, dependency cleanup, or
remote branch deletion. Those are separate reviewable changes.

## Execution Update — Stages 1–3 And Issue Closure

The recommended P0 implementation slice was completed on 2026-07-10. This
section records the resulting public evidence so a later maintainer does not
repeat the same work.

### Stage 1: version-bound release evidence

Release impact now comes from `.buildchain/release-impact.json`, participates in
version state, and is verified against the target version and minor line before
publication. Ref Promotion and Binary Distribution consume the same durable
record instead of overwriting each other with workflow defaults. The delivery
spanned PRs #1001, #1007, #1013, #1017, #1020, and #1022. Public alpha
`v2.11.11-alpha.2` and its promotion/Binary Distribution runs proved the final
asset agreement.

### Stage 2: promotion serialization and deduplication

PR #1030 added the global non-canceling queue, early target ancestry
revalidation, and a governed superseded no-op at the mutation boundary. Public
alpha `v2.11.13-alpha.1` was the effective mutation. Run 29072416507 attempt 2
replayed the old intent and stopped after preflight without moving refs or
opening a new friction issue. Historical issue #1024 was closed with this
evidence; its original late failure was not treated as justification to widen
the version-state recovery allowlist.

### Stage 3: generated trigger canonicalization

PR #1033 made unchanged JSON/TOML versions semantic no-ops and replaced TOML
reserialization with a parser-verified lossless edit. This removed formatter-only
paper preparation commits while keeping substantive version changes and strict
source identity checks. PR #1034 published `v2.11.13-alpha.2`; the generated-head
follow-up promotion was skipped, and issue #1029 was closed.

### Open issue audit and newly discovered archive defect

PR #1035 completed the paper publication evidence contract: only
`.buildchain/contract-drift/` and `.buildchain/publication-result.json` are
accepted as Buildchain-owned untracked ephemeral evidence, and protected release
authority is checked before expensive paper build work. Issues #1009, #1011,
#1012, #1015, #1024, and duplicate feedback #1032 were then closed with links to
their fixing PRs and successful runs.

The audit also surfaced issue #1036: the web-surface adapter applied
`sync --delete` across the site root and could remove historical publication
versions absent from the current package set. PR #1037 now consumes the existing
publication archive policy from each surface manifest, propagates immutable
delete exclusions to owning and parent surface syncs, verifies existing S3
object digests, uploads missing objects with `--no-overwrite`, verifies again,
and records apply/health evidence. A deploy-plan-only build of the current
`site-libkungfu-dev` artifact identified 3 declared version prefixes and 15
immutable files, with `papers/archive/*` excluded from the parent hub sync and
`archive/*` excluded from the papers sync. No AWS apply was used for that
validation.

PR #1038 published `v2.11.13-alpha.3@fee1c64e`. Ref Promotion run 29079959309
and Binary Distribution run 29080058370 completed; npm `alpha` points to
`2.11.13-alpha.3`, npm `latest` remains `2.11.12`, and the public impact asset
names `web-surface-immutable-publication-archive`. At this update, the repository
has no open GitHub issues.

### Stage 4: stable release throttle decision and canary gate

The maintainer decision closes the cadence question with a minimum gate rather
than a release schedule. Train and alpha remain fast. Stable promotion requires
a product or contract diff, a 24-hour minimum interval from the preceding
stable, the named `Build Surface Fixture` and no-apply `site-libkungfu-dev`
canaries, and a one-hour soak after the final canary. The exact policy and
attestor boundary live in `.buildchain/stable-release-policy.json`; passing and
blocked decisions use the auditable `kungfu-buildchain-stable-release-gate`
report.

The `v2.11.13` promotion also exposed issue #1042 after its durable transaction,
exact tag, floating refs, npm package, GitHub Release, and binary assets were
already complete. Next-alpha bookkeeping compared the generated tree directly
with a dev head that had gained this retrospective and rejected that legitimate
concurrent file. Stage 4 changes generated next-alpha reconciliation to overlay
only declared version-state paths on the current dev tree. It also makes any
remaining post-complete bookkeeping failure deferred work instead of reversing
the observed stable-release result.

### Post-closure correction: issue #1043 source checkout

PR #1055 added bounded retries for the GitHub fallback path and automatically
closed issue #1043. Later runner evidence showed that closure was incomplete:
the failing source checkout first spent the cache timeout on a raw SHA fetch,
then attempted an 83 MB advertised-ref snapshot under the same 60-second
budget. On a constrained 5 Mbps uplink the two sequential fetches produced the
observed roughly 120-second failure window; retrying the same transfer did not
remove the structural threshold.

The corrected contract fetches the advertised source ref before attempting a
raw SHA. That lets a current mirror satisfy the checkout immediately and lets a
stale mirror seed reusable objects before GitHub fallback. A retryable ref
transport failure returns directly to the bounded retry loop instead of
spending a second full timeout on an unadvertised SHA. Cache transport retains
its 60-second default while GitHub fallback receives an independent, explicit
600-second default budget. Exact commit and tree verification remain mandatory
after either route. The `v2.11.14` release candidate must be regenerated after
this correction; earlier `v2.11.14-alpha.4` canary evidence must not be reused.

### Consumer adoption correction: major alpha floating channel

Per-minor alpha refs such as `v2.11-alpha` forced consumers to edit workflow
pins whenever Buildchain opened a newer v2 minor. Buildchain now derives a
generic `vN-alpha` for every major. It moves only when the promoted alpha or
post-stable next-alpha belongs to the highest minor in that major with a
published alpha. An older minor can continue maintenance releases, but records
`skipped-newer-minor-alpha-exists` instead of rolling the major alpha channel
backwards. Exact alpha tags and SHAs remain the immutable audit and rollback
surface; `vN-alpha` is the low-friction continuous dogfood entrypoint.

### Stage 5: vN-alpha self-dogfood canary

The floating alpha channel now has a Buildchain-owned consumer loop rather
than relying only on downstream adoption. A scheduled, post-promotion, and
manually dispatchable workflow calls the released `@v2-alpha` outer reusable
workflow and runs a direct stable `v2` runtime compatibility lane with the same
bounded Linux fixture. The stable lane does not require the preceding stable
outer workflow to contain the new self-call identity fix. The canary compares
each resolved runtime SHA with the corresponding GitHub tag and uploads a small
evidence record.

The first live run, `29131395486`, proved the evidence gate by rejecting both
released outer calls after they resolved the self-caller's
`refs/heads/dev/v2/v2.11` instead of the requested floating refs. The alpha lane
therefore remains the true outer-workflow canary; the stable lane tests the
released runtime directly until a later stable release naturally contains the
called-workflow identity correction.

After `v2.11.14-alpha.7` moved `v2-alpha` to `d7b94536`, run `29132027756`
proved that called-workflow ref selection was fixed, then stopped at the next
independent contract boundary: Buildchain's stable consumer lock predated four
reviewed alpha breaking digests. The self-dogfood lane now owns a separate
alpha contract lock accepted at the exact alpha.7 SHA. Stable consumers retain
their stable lock, and future alpha breaking-digest changes still fail closed
until reviewed.

Implementation exposed a prior identity blind spot: GitHub associates
`github.workflow_ref` with the caller during reusable workflow execution, while
`job.workflow_ref` identifies the workflow that defines the called job. The
reusable build trust gate now prefers `job.workflow_ref`, so a call through
`@vN-alpha` defaults to the selected alpha runtime instead of the caller's
branch. Full `refs/tags/*` and `refs/heads/*` workflow identities are normalized
before runtime selection. The canary shares promotion serialization so its ref
comparison cannot race a later floating-tag move. Inventory and unit checks
preserve those distinctions. Promotion remains bound to the verified exact SHA;
patrol, repair, and dev-merge defaults do not depend on the floating alpha they
may need to repair.

### Stage 6: automatic consumer channel router

Consumers previously needed two nearly identical reusable-workflow calls to
select `vN-alpha` during development and `vN` for a stable release. Buildchain
now provides an additive `build.yml` router. Its default `auto` policy derives
the major line and selects the generic alpha floating ref for development,
pull-request, and prerelease intent, then selects the stable major floating ref
for a stable release. Explicit channel and exact trusted runtime overrides
remain available; ambiguous release-like evidence fails closed. The existing
`.build.yml` advanced surface keeps its prior semantics.

Because the router is a new public reusable-workflow surface and input
protocol, KFD-1 classifies it as a minor change. The implementation therefore
opens `v2.12` and targets `2.12.0-alpha.0` instead of extending the `v2.11`
patch line.

Train canary `29134325376` exercised the new outer router in both modes with a
single bounded Linux fixture. The alpha lane resolved `v2-alpha`; the stable
lane resolved `v2`; both contract locks, build lifecycles, summaries, and the
final floating-ref comparison passed. The preceding run `29134106772` had
correctly failed the stable lane because Buildchain's own stable consumer lock
still accepted an older `v2`. That lock was refreshed to the exact reviewed
stable SHA `618512fd874cc0125cc8a3daa07ef4d1b195777e`; no compatibility gate was
bypassed or weakened.

### Remaining work

This closure does not approve an automatic stable-release schedule, ref
retention policy, module decomposition, dependency cleanup, or a live repair of
already missing consumer archive objects. Those remain separate, reviewable
tasks. Any repair of published S3 state must start with an exact dry-run, digest
comparison, impact, and rollback plan.

## Handoff Procedure

1. Fetch `origin` and confirm the current default `dev/*` line.
2. Create a feature or fix branch targeting that protected dev line.
3. Read this record together with `CONTRIBUTING.md`, `docs/MAP.md`,
   `docs/release-governance.md`, `docs/release-flow.md`, and
   `docs/release-passport.md`.
4. Install the pinned workspace dependencies and run `pnpm run check` before
   and after the implementation.
5. Use train/alpha validation before moving the stable `v2` trust surface.
6. Preserve durable evidence refs and exact tags; cleanup work requires a
   separate retention proof.

## Source Boundary And Open Questions

This review used repository files, Git history and refs, public GitHub releases,
pull requests, issues, and Actions run metadata available on 2026-07-10. It did
not inspect provider credentials, private logs, billing data, or unpublished
consumer repositories.

Open questions for the next maintainer decision:

- When should a second independent consumer join the minimum stable canary set?
- Should promotion serialization be global first, or keyed by release line from
  the first implementation?
- Which version-state and train refs remain required for rollback, and for how
  long?
- What size or change-frequency threshold should trigger mandatory internal
  module extraction?
