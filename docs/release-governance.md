# Release Governance

Buildchain v2 preserves the release semantics of the older ABV workflow while
moving the implementation into one modern repository.

The central idea is simple: a reviewed merge into a release channel is the
release intent. Automation must then create the version-state commit, exact tag,
floating tag, and next alpha state that make that intent true in Git.

## Design Problem

Kungfu release automation has to keep four facts aligned:

1. The source tree that was reviewed.
2. The package version recorded in manifests such as `package.json` or
   `lerna.json`.
3. The exact immutable release or prerelease tag.
4. The floating channel refs that consumers actually use.

If any one of these facts is updated by hand, the system can split:

- a consumer can fetch `v2.0` and receive a tree whose package version still
  says the previous release;
- a maintainer can move `v2` without producing an exact `v2.0.N` audit tag;
- an alpha can be promoted to production even though the release tree is not the
  same tree that was tested;
- a protected branch merge can succeed while the follow-up version commit is
  missing, or a flow-internal generated `dev`/`alpha`/`release` ref update can
  fail after publish because the automation identity was not declared in the
  branch-protection review bypass allowance.

The older ABV workflow addressed this by letting GitHub PRs drive release
state. Buildchain keeps that choice because it makes release intent reviewable,
observable, and recoverable from Git history.

## What ABV Contributed

The old ABV model was not just "bump a version number." It encoded a governance
loop:

- release branches are named as channels: `dev`, `alpha`, `release`, and the
  administrative `publish-gate/major`;
- a PR from one channel to the next is the release request;
- verify jobs check that the branch pair is valid before merge;
- a maintainer review is required before the branch moves;
- after merge, automation writes the version change and moves tags;
- exact tags and floating refs are aligned with the resulting commit;
- the next development channel is prepared automatically.

ABV also kept the version-state mutation in the repository. For JavaScript
repositories that usually meant changing `lerna.json` and/or `package.json`.
That commit is important because the tag alone is not enough evidence: the
source tree should also declare the version that the tag advertises.

Buildchain v2 treats that as a hard semantic requirement for its own release
line.

## Buildchain Implementation

Buildchain implements the same governance loop with:

- `.github/workflows/release-verify.yml` for PR verification;
- `.github/workflows/buildchain-ref-promotion.yml` for post-verify ref
  promotion; this workflow dogfoods the declarative
  `release-candidate-promote.yml` wrapper and does not hand-wire resolver,
  artifact download, publish-gate, or promote action steps;
- Buildchain self promotion enables `release-passport-buildchain-self-kfd`, so
  the promote action generates KFD-1 witnesses, KFD-2 public claim JSON, and
  KFD-3 collaboration-interface witnesses from the final version-state workspace
  before release passport finalization. The witness hashes therefore bind to the
  exact published package and site facts from
  `packages/core/buildchain-kfd-claims.js` instead of relying on prose release
  notes;
- `actions/promote-buildchain-ref` for branch, tag, version-state, and
  governance checks;
- package-manager adapters that can update version state for pnpm, npm, and
  yarn style repositories;
- `buildchain.toml` lifecycle configuration for repositories whose version
  state or verification commands are not Node package-manager defaults.

The implementation is intentionally stricter than a local release script:

- manual workflow dispatch can only do dry-run promotion;
- non-dry-run promotion must be driven by a completed `Verify` workflow;
- target branch protection details must be readable, and branch protection must
  apply to administrators as well as regular contributors;
- alpha promotion must come from a merged same-repository PR from
  `dev/vX/vX.Y` to `alpha/vX/vX.Y`;
- release promotion must come from a merged same-repository PR from
  `alpha/vX/vX.Y` to `release/vX/vX.Y`;
- major promotion must come from a merged same-repository PR from
  `release/vX/vX.Y` to `publish-gate/major`;
- release promotion requires an existing same-patch alpha tag and checks the
  release source tree against that tested alpha tree;
- generated version-state commits are verified before refs move.

Exact publication planning installs the checked-out promotion source's declared
dependencies before version-state verification. This keeps the pre-authority
version plan on the same package-manager boundary as the later promotion job,
including repositories whose verification commands import production packages.
The planning pass may materialize and verify declared derived files locally,
but dry-run never creates Git blobs, trees, commits, refs, or tags.

Promotion intents are serialized globally per caller repository with
`cancel-in-progress: false`. A queued intent re-reads its protected target ref
before checkout, dependency installation, release-candidate resolution, or any
publish-gate/ref mutation. If the ref already points at a newer SHA, that older
intent is no longer release authority: the workflow records the requested and
current SHAs, proves that the current target is ahead of the requested commit,
and completes as a `target-ref-advanced` superseded no-op. Diverged or behind
comparisons are not superseded transactions and still fail closed.
Missing refs, unreadable repository state, invalid channels, governance
failures, and artifact mismatches still fail closed. The promote action repeats
the target check at the mutation boundary, so a ref that advances after the
workflow preflight cannot receive a second set of publication side effects.

## Version Lines

Kungfu uses Python-like version lines where a minor line can represent a
long-lived product train. A line such as `v2.0` can produce many production
patch releases:

```text
v2.0.0
v2.0.1
v2.0.2
...
v2.0.1234
```

This is why Buildchain maintains both exact and floating refs:

- `v2.0.2` is immutable release evidence;
- `v2.0` is the latest production release on the `2.0` line;
- `v2` is the selected stable major-line entrypoint;
- `v2.0.3-alpha.0` is immutable alpha evidence;
- `v2.0-alpha` is the latest test channel for the `2.0` line.
- `v2-alpha` is the latest test channel on the highest published alpha minor in major `2`.

A release does not mean "minor is complete." It means "this patch on this minor
line is now production."

GitHub repository rules must preserve that distinction. Exact tags such as
`v2.0.2` and `v2.0.3-alpha.0` should be immutable. Floating channel tags such as
`v2`, `v2.0`, `v2.0-alpha`, and `v2-alpha` must remain movable by the Buildchain promotion
token after governance checks and publish evidence pass. A tag ruleset that
protects every `refs/tags/v*` ref is too broad because it also locks the
floating channel tags that Buildchain is required to update. Prefer exact-tag
patterns such as `refs/tags/v*.*.*` for immutable release evidence, while
leaving floating channel tags under Buildchain automation control.

## Alpha Semantics

An alpha merge is:

```text
dev/vX/vX.Y -> alpha/vX/vX.Y
```

Buildchain then:

1. Computes the next prerelease for the minor line.
2. Writes version state such as `vX.Y.Z-alpha.N`.
3. Verifies the generated version-state tree.
4. Creates or reuses the exact alpha tag.
5. Moves `alpha/vX/vX.Y` to the generated alpha commit.
6. Moves `dev/vX/vX.Y` to the same generated alpha commit when this is a
   fast-forward update.
7. Moves `vX.Y-alpha` to the same generated alpha commit.
8. Moves `vX-alpha` only when `X.Y` is the highest minor in major `X` with a published alpha; older minor alpha work records a skip and cannot move the major channel backwards.

This keeps the test channel self-describing. If a consumer checks out
`v2.0-alpha` or `v2-alpha`, the manifests and exact alpha tag agree. The major
alpha ref removes routine consumer edits when Buildchain opens a newer minor,
while exact tags and SHAs remain the reproducible audit choice.

### Buildchain Alpha Self-Dogfood

Buildchain continuously consumes its own current major alpha through
`.github/workflows/buildchain-alpha-self-dogfood.yml`. Both lanes call the
released channel router at `build.yml@v2-alpha`. The auto lane must resolve
`v2-alpha`; the explicit stable lane must resolve `v2`. Both execute the same
declared install, build, and verify fixture, proving that a single consumer
surface routes to distinct released runtimes without duplicating lifecycle
configuration in the consumer.

The reusable build trust gate reads `job.workflow_ref`, which identifies the
called workflow and its selected ref. It does not infer the runtime from
`github.workflow_ref`, because GitHub defines that context as the caller
workflow identity during a reusable call.

The router selects `.buildchain/alpha-contract-lock.json` for alpha and
`.buildchain/contract-lock.json` for stable. The alpha lock records the exact
reviewed alpha SHA and compatibility digest; it does not replace the stable
consumer lock. A later alpha with only compatible additive drift continues,
while a changed breaking digest fails until the new alpha contract is reviewed.

The evidence job resolves `v2-alpha` and `v2` through the GitHub refs API,
compares those immutable SHAs with the reusable workflow outputs, verifies the
`alpha` and `stable` classifications, and uploads a JSON evidence artifact.
The canary runs after successful Buildchain ref promotion, on a daily fallback
schedule, and on manual dispatch. It shares the release-promotion concurrency
group, so another promotion cannot move the floating refs between runtime
resolution and evidence comparison.

This is a post-publication consumer canary, not a release bootstrap. Source
verification still runs the current commit, and
`buildchain-ref-promotion.yml` still passes the verified exact SHA into the
promotion workflow. Patrol, dev-merge, repair, and promotion defaults remain on
stable or exact refs so a broken alpha cannot prevent Buildchain from publishing
its fix. When Buildchain opens a new major, inventory validation requires this
workflow's fixed GitHub `uses` refs to move from `vN`/`vN-alpha` to the new
major; GitHub does not allow expressions in a reusable-workflow `uses` ref.

If `dev/vX/vX.Y` has already advanced before generated alpha version-state
bookkeeping can sync back, Buildchain records `skipped-non-fast-forward` for the
dev sync and still completes the exact and floating alpha tags for the reviewed
alpha commit. Later dev changes must go through their own dev-to-alpha
promotion instead of rewinding dev. The normal path is direct: after alpha
merges, Buildchain applies the generated version-state commit to alpha and then
fast-forwards dev to the same commit without a human version-state PR.

If alpha finalization is resumed after generated version-state bookkeeping was
partially applied, Buildchain accepts the current alpha head as the generated
commit, or as a historical merge commit that contains the recorded release
material. An already-created exact alpha tag may point at the transaction
release/material SHA or at the finalized alpha head; missing floating alpha
tags are retried before the transaction becomes `complete`.

## Release Semantics

A release merge is:

```text
alpha/vX/vX.Y -> release/vX/vX.Y
```

Buildchain then:

1. Finds the same-patch alpha tag that was tested.
2. Checks that the release source tree matches that alpha tag tree, excluding
   only generated version-state differences.
3. Writes final release version state such as `vX.Y.Z`.
4. Verifies the generated release tree.
5. Creates or reuses the exact release tag `vX.Y.Z`.
6. Moves `release/vX/vX.Y` to the exact release commit.
7. Moves `vX.Y` to the exact release commit.
8. Moves `vX` when this minor line should be the stable major entrypoint.
9. Prepares the next alpha version-state commit, such as
   `vX.Y.(Z+1)-alpha.0`.
10. Moves `alpha/vX/vX.Y`, `dev/vX/vX.Y`, and `vX.Y-alpha` to that next alpha
    commit.
11. Moves `vX-alpha` to that next alpha only when this remains the highest published alpha minor.

The production channel and the test channel therefore intentionally diverge
after release: production stays on the release commit, while alpha/dev continue
at the next prerelease commit.

### Stable Release Throttle And Canary Gate

Buildchain's own stable channel has an additional pre-publication gate. It is
evaluated after the PR-stage release candidate has been resolved and before the
publish-gate ref, package registry, exact stable tag, or floating stable refs
are mutated. Train refs and alpha promotion do not execute this gate.

All alpha and release promotions first run a metadata-only release-candidate
preflight after queued-intent revalidation. The preflight uses the same resolver
and exact target SHA as the publication job, but does not download payloads or
install the candidate repository dependencies. Missing channel PRs, stale
workflow runs, expired passport pairs, and insufficient payload artifact sets
therefore fail before the full promotion job starts. The publication job still
downloads and validates the exact evidence again at the trust boundary; the
preflight moves failure earlier without weakening the final check.

The policy is versioned in `.buildchain/stable-release-policy.json`. A stable
candidate is allowed only when all of these facts are true:

- the candidate resolves to an immutable exact alpha tag and its GitHub
  prerelease timestamp;
- at least 24 hours have passed since the preceding stable patch on the same
  minor line;
- the preceding stable-to-alpha comparison contains a product or public
  contract path, not only version, test, evidence, or retrospective changes;
- the version-bound impact record has a non-empty summary and at least one
  surface impact;
- the `Build Surface Fixture` release-candidate run succeeded;
- `site-libkungfu-dev` completed its no-apply `Buildchain Stable Canary` and an allowed
  maintainer attested that successful run on the exact alpha SHA through the
  `buildchain-canary/site-libkungfu-dev` commit-status context;
- the canary runtime input is exactly the candidate alpha tag or the 40-character
  commit SHA resolved from that tag; a successful status pointing at another
  workflow, repository, tag, floating ref, or SHA is rejected as mismatched;
- at least one hour has elapsed after the last required canary completed.

The machine report is written to
`.buildchain/release-passport/stable-release-gate.json`. A passing report is
uploaded with the stable release passport. A blocked run writes the same report
before failing, so the missing or stale condition is inspectable without
opening a publication transaction.

GitHub's Actions run REST object does not expose `workflow_dispatch` inputs.
Buildchain therefore verifies the run's `workflow_id` against the authoritative
workflow metadata, then reads the exact runtime from the workflow-owned
`<workflow name> / <runtime ref>` run-name when no input field is available.
An explicit API input, when present, remains authoritative and cannot be
overridden by the display name.

The cooldown is a minimum interval, not an instruction to release every day.
Compatible work should still be batched until a stable release has a concrete
consumer need. Changing the interval, canary set, attestors, product path
boundary, or soak time is a reviewed policy change.

Repositories that want a predictable scheduled stable window can use
[`Stable Candidate Patrol`](stable-candidate-patrol.md). It persists each exact
alpha independently, qualifies it after repository-declared checks and soak,
and selects the newest qualified non-revoked candidate. A newer soaking alpha
does not invalidate an older qualified candidate. The selected tree enters the
existing strict `publish-gate/release/<line>/<version> -> release/<line>` PR
path, so scheduled selection changes release intent timing without weakening
source locks, review, verification, publish transactions, or passports.

If release finalization is resumed after generated version-state bookkeeping was
partially applied, Buildchain applies the same recovery rule: the current
release head may be the generated commit, or a historical merge commit that
contains the recorded release material, existing exact tags and alpha/dev refs
are accepted when they match the transaction, and missing floating `vX.Y` or
`vX` tags are retried idempotently before completion.

Once the durable release transaction is `complete` and the exact/floating
stable refs have moved, next-alpha preparation is post-release bookkeeping. A
failure there records `deferred-post-release-bookkeeping` and
`next-anchor-required` instead of retroactively reporting the stable release as
failed. Generated next-alpha merges use the current dev tree as their base and
overlay only declared version-state paths, preserving concurrent dev changes.

## Major Gate Semantics

A major gate merge is:

```text
release/vX/vX.Y -> publish-gate/major
```

`publish-gate/major` is the explicit replacement for the older ABV `main`
channel. The name is intentionally operational: it is a gate for a rare
administrator decision, not the active trunk. Keeping this decision in the same
PR UI as alpha and release promotion keeps the human workflow simple while
avoiding the misleading meaning of `main`. The older `major-gate` branch name is
a compatibility alias only.

Buildchain then:

1. Verifies the source is a merged same-repository PR from a protected release
   line into `publish-gate/major`.
2. Writes the next major production version state, such as `v(X+1).0.0`.
3. Creates or reuses the exact release tag `v(X+1).0.0`.
4. Moves `publish-gate/major` and `release/v(X+1)/v(X+1).0` to that release commit.
5. Moves `v(X+1).0` and `v(X+1)` to that release commit.
6. Prepares the next alpha version-state commit, such as
   `v(X+1).0.1-alpha.0`.
7. Moves `alpha/v(X+1)/v(X+1).0`, `dev/v(X+1)/v(X+1).0`, and
   `v(X+1).0-alpha` to that next alpha commit.

Checking out `publish-gate/major` should therefore look like a frozen release
state, not like a branch where day-to-day source work continues. Day-to-day
source work continues on `dev/vX/vX.Y`.

## Protected Dev Branches

`dev/vX/vX.Y` is a protected development channel, not a scratch branch. Normal
source changes should be made on work branches such as `feature/*`, `fix/*`,
`chore/*`, `docs/*`, `ci/*`, or `refactor/*`, then reviewed through a pull
request into the target dev line.

This keeps the earliest development channel audit-friendly:

- the version line being changed is visible in the PR base branch;
- CI and required checks run before the channel moves;
- branch protection can prevent direct pushes and stale merges;
- later `dev -> alpha -> release` promotion inherits a reviewable source
  lineage instead of trying to reconstruct how the dev branch changed.

Buildchain provides the reusable
`.github/workflows/dev-pr-auto-merge.yml` workflow for repositories that want a
scheduled or manual "merge ready dev PRs" pass. The consumer repository owns
the trigger schedule, but the merge decision is declared through workflow
inputs: target dev branch, required status/check names, ready and block labels,
allowed work-branch prefixes, review requirements, maximum merges per run,
merge method, and dry-run mode.

The workflow defaults are conservative. A PR is skipped unless it targets the
configured dev line, is not a draft, has the ready label, has no block label,
comes from the same repository, uses an allowed work-branch prefix, has a
current approval, is mergeable, and has the configured required checks passing.
After each merge, the next PR is re-evaluated before it can move the protected
dev branch. This prevents one merge from silently making the next candidate
stale or conflicting.

The canonical consumer required check context is `check / check`, matching the
reusable workflow call plus its `check` job. Buildchain's own `Verify` workflow
emits the repository-local context `check`, so Buildchain self-promotion,
release-line bootstrap, and dogfood patrol wrappers pass `check` explicitly.
Release governance preserves the exact context emitted by the repository and
records branch-protection policy before/after facts; it does not rewrite one
context shape into the other. Consumer repositories can keep their context
stable while changing the actual verification command declaratively in
`buildchain.toml`:

```toml
[lifecycle.install]
command = "cargo fetch --locked"

[lifecycle.verify]
command = "cargo test --workspace --locked"
```

Consumers that want Buildchain to own the check wrapper can call
`.github/workflows/check.yml@v2`. The wrapper runs the declared
`lifecycle.install` and `lifecycle.verify` stages and fails the `check` job when
either declaration is missing or the command exits non-zero.

Development pull requests that need source acceptance without product build or
artifact verification can opt into `mode: source`. That mode runs only
`lifecycle.install` and `lifecycle.check` on GitHub-hosted `ubuntu-24.04` while
preserving the stable `check / check` required-check context. Existing callers
remain on `mode: verify` by default, and callers may set
`upload-artifacts: false` without weakening the job conclusion.

Typical consumer wrapper:

```yaml
name: Merge Ready Dev PRs

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true

jobs:
  merge-dev:
    uses: kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@v2
    permissions:
      contents: write
      pull-requests: write
      checks: read
      statuses: read
    with:
      target-branch: dev/v2/v2.6
      required-status-checks: check / check
      ready-label: ready
      block-labels: blocked,do-not-merge
      max-merges: 1
      dry-run: ${{ inputs.dry-run || false }}
```

## Buildchain Patrol

`dev-pr-auto-merge.yml` remains the focused merge primitive. For repositories
that want a stable day-to-day operations contract, Buildchain also exposes a
patrol workflow family:

| Workflow | Intended cadence | Default intent |
| --- | --- | --- |
| `.github/workflows/patrol-daily.yml` | daily | lightweight inspection plus ready dev PR maintenance |
| `.github/workflows/patrol-weekly.yml` | weekly | release-state, passport, gate, and stale-state health checks as they are added |
| `.github/workflows/patrol-monthly.yml` | monthly | governance, permission, branch-protection, and workflow drift checks as they are added |
| `.github/workflows/stable-candidate-patrol.yml` | repository-selected release window | qualify immutable alpha candidates and open the exact source-lock stable PR |

The cadence names describe patrol intensity, not release cadence:

- daily patrol can run every day without implying a daily release;
- weekly patrol is for medium-cost maintenance and audit checks;
- monthly patrol is for structural drift checks that should not block ordinary
  development velocity.

Stable Candidate Patrol is separate from those maintenance cadences because its
caller-owned cron is a release-intent window. Its candidate ledger and selection
remain generic; registry-specific side effects still run through the normal
repository `lifecycle.publish` transaction. See
[`stable-candidate-patrol.md`](stable-candidate-patrol.md).

Consumers should schedule thin callers and keep their YAML declarative. For
example:

```yaml
name: Buildchain Daily Patrol

on:
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch:

jobs:
  patrol:
    uses: kungfu-systems/buildchain/.github/workflows/patrol-daily.yml@v2
    with:
      dry-run: false
      max-actions: 1
```

Weekly and monthly callers use the matching wrapper:

```yaml
jobs:
  patrol:
    uses: kungfu-systems/buildchain/.github/workflows/patrol-weekly.yml@v2
    with:
      dry-run: true
```

All three wrappers default to the `v2` floating Buildchain runtime. When
`target-branch` is omitted, the caller's current/default branch selects the
active semver dev line, so consumers do not pin patrol to a stale minor branch.
The separate workflow names keep consumer schedules readable and stable while
Buildchain adds new checks behind the cadence wrappers.

## Package-Manager Adapters

Old ABV assumed JavaScript repositories with root version state and often
Lerna. Buildchain keeps the version-state contract but does not assume every
repository is yarn/Lerna.

The promotion action discovers and updates:

- root `package.json`;
- `lerna.json`;
- package manifests from `package.json` workspaces;
- package manifests from `lerna.json` packages;
- package manifests from `pnpm-workspace.yaml`.

It then runs the repository's detected package manager semantics where needed:

- pnpm repositories use pnpm-oriented workspace discovery;
- npm repositories use npm/package-lock semantics where present;
- yarn repositories use yarn-style metadata where present.

For Buildchain itself, version state is required. For a consumer repository that
has no package manifest, the same action can degrade to ref-only behavior only
when that is explicitly allowed by the caller.

## Lifecycle Configuration

`buildchain.toml` is the v2 user configuration format. It lets a repository
declare version-state files and lifecycle commands without pretending every
project is a Node workspace. Supported version files include JSON, TOML, and
regex-based files such as `CMakeLists.txt` or `conanfile.py`.

The promotion action currently consumes `version.files` and `lifecycle.verify`.
The verify stage runs after generated version-state changes are applied locally
and before any release refs move. If `verification-command` is passed directly
to the action, that explicit command overrides `lifecycle.verify`.

Protected release-line branches keep their normal human review gate. Managed
`dev/vN/vN.M`, `alpha/vN/vN.M`, and `release/vN/vN.M` branches are configured
with one required approving review, strict GitHub Actions checks, administrator
enforcement, conversation resolution, no force pushes, and no deletions. The
reusable `release-candidate-promote.yml` wrapper defaults
`branch-protection-bypass-apps` to `github-actions`, which lets the workflow's
automation identity apply generated version-state or post-publish channel
bookkeeping after the reviewed channel PR has merged. Direct
`promote-buildchain-ref` callers must opt into the same controlled bypass with
`branch-protection-bypass-apps`, `branch-protection-bypass-users`, or
`branch-protection-bypass-teams`; the action also adds the current promotion
token's authenticated user or app to the managed bypass allowlist. Before
patching a protected generated bookkeeping ref, the action creates the
configured required check on the exact generated version-state commit, so strict
status checks are satisfied by machine-verifiable Buildchain evidence rather
than a human PR. The protected ref PATCH itself uses the generated ref update
token; the reusable wrapper defaults it to
`secrets.BUILDCHAIN_PROMOTION_TOKEN || github.token`. If direct generated
release finalization bookkeeping is still rejected, Buildchain creates or
reuses a same-repository `buildchain/version-state/*` PR based on the current
target channel head and records `finalization-needed=true` in the durable
transaction output. Strict alpha bookkeeping still fails with a
token/protection diagnostic instead of creating a post-publish PR.

For a stable release, the wrapper also checks out the exact current development
channel into `.buildchain/reconciliation/dev`. When the prepared next-alpha
commit cannot fast-forward dev because reviewed work landed concurrently, the
promotion action applies the next version to that checkout, regenerates every
declared derived version-state file, reruns the verification lifecycle, and
only then creates the two-parent reconciliation commit. A checkout/current-ref
SHA mismatch blocks reconciliation instead of committing stale projections.
Buildchain's own promotion workflow reads `BUILDCHAIN_PROMOTION_BYPASS_APPS`,
`BUILDCHAIN_PROMOTION_BYPASS_USERS`, and
`BUILDCHAIN_PROMOTION_BYPASS_TEAMS` repository variables so the declared bypass
identity can match the actual `BUILDCHAIN_PROMOTION_TOKEN` actor, but consumers
do not need to duplicate that actor manually when the token identity is
discoverable. Buildchain's release-line bootstrap applies the same declared
allowances when it creates new `dev`, `alpha`, and `release` branch protection,
and fails closed before changing protection when no promotion authority is
declared. This keeps a new minor line publishable without weakening its normal
human review gate.

## What This Guarantees

When the loop succeeds, maintainers and consumers can rely on these facts:

- every production release has an exact tag such as `v2.0.2`;
- every production minor line has a floating tag such as `v2.0`;
- every selected stable major has a floating tag such as `v2`;
- every next-major release is driven by a reviewed `release -> publish-gate/major` PR,
  not a hidden manual button;
- every test channel has an exact alpha tag such as `v2.0.3-alpha.0`;
- every alpha minor line has a floating tag such as `v2.0-alpha`;
- every major with a published alpha has a cross-minor floating tag such as `v2-alpha`, owned by its highest published alpha minor;
- version manifests match the tag visible from the same commit;
- production releases are derived from the alpha tree that was tested;
- manual non-dry-run promotion cannot bypass PR review and verification;
- flow-internal automation bypasses apply only to declared GitHub Apps, users,
  or teams on Buildchain-managed channel branch protection, while one-review
  protection remains enforced for humans;
- admin users cannot make a channel promotion valid by temporarily bypassing
  branch protection.

This is the practical meaning of "governance closed loop" in Buildchain: the
decision, code, version state, and Git refs close over the same evidence chain.

## What This Does Not Do

Buildchain release promotion does not embed registry clients or product-specific
publish logic. When publish transactions are enabled, `promote-buildchain-ref`
can run the consumer's `lifecycle.publish` command and own the transaction,
evidence validation, durable recovery state, and ref finalization order. The
consumer repository still owns registry truth: npm, PyPI, OCI, S3, Conan, CMake
packaging, download pages, dist-tags, and similar side effects must be
implemented by project lifecycle commands that emit Buildchain publish evidence.

Every Buildchain publish model that can run registry side effects must bind the
publish entrypoint to an immutable `publish-gate/*` source lock. The reusable
`release-candidate-promote.yml@v2` wrapper creates or updates that gate ref and
passes `require-publish-source-lock`, `publish-source-ref`,
`publish-source-sha`, and `publish-source-locked` to
`promote-buildchain-ref`. Direct action callers must pass the same four inputs
from the reusable build outputs. Workflows that only collect passports or run
dry-run package checks do not move publish refs and are not publish-gate
publication models. A dry-run of `release-candidate-promote.yml` computes and
reports the exact `publish-gate/*` source lock that a real promotion would use,
but does not read, create, or move that ref.

Semver GitHub Release publication is owned by `promote-buildchain-ref`, not by
consumer shell glue. Consumers normally use the `release-candidate-promote.yml`
wrapper, where GitHub Release publication is enabled by default and can be
disabled with `github-release: false`; the wrapper passes that declaration to
the action. After the publish transaction reaches `complete`, Buildchain creates
or updates the public GitHub Release and uploads the generated
`buildchain.release.json`, release-passport assets, and publish evidence. Semver
prerelease tags are marked `prerelease=true` and `make_latest=false`; stable
semver tags are marked latest. For anchored/manual package releases, the public
release tag defaults to `v<publishedVersion>` while the internal exact
transaction tag remains in the release passport and release-state ref. This is
the supported path for downstream
`release.published` propagation across semver, major, and promote-only release
candidate publication models.

Buildchain also does not maintain bare exact tags such as `1.0.0`. The supported
exact release and alpha refs are v-prefixed:

```text
v2.0.0
v2.0.1-alpha.0
```

## Operational Reading Order

When debugging or extending release behavior, read in this order:

1. `docs/release-flow.md`
2. `.github/workflows/release-verify.yml`
3. `.github/workflows/buildchain-ref-promotion.yml`
4. `.github/workflows/release-candidate-promote.yml`
5. `actions/promote-buildchain-ref/README.md`
6. `actions/promote-buildchain-ref/src/`
7. `docs/migration-inventory.md`

That path gives the policy first, the workflow trigger second, and the action
implementation last.
