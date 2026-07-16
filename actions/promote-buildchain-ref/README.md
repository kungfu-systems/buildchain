# promote-buildchain-ref

Internal buildchain action for promoting verified buildchain release-line and
compatibility refs from buildchain release channels:

- `alpha/v2/v2.0` creates or reuses the next exact prerelease tag such as
  `v2.0.1-alpha.0`, writes that version into package version state, points the
  alpha and dev channel branches at the version commit, then promotes
  `v2.0-alpha` and, when this is the highest published alpha minor, `v2-alpha`;
- `release/v2/v2.0` creates or reuses the next exact release tag such as
  `v2.0.0`, writes that version into package version state, points the release
  channel branch and release tags at the release commit, then prepares a second
  source commit for the next exact prerelease tag such as `v2.0.1-alpha.0` and
  points the alpha/dev channel branches plus `v2.0-alpha` at that prerelease
  commit, and moves `v2-alpha` only if no higher v2 minor has published an alpha;
- `publish-gate/major` accepts a reviewed PR from a production release line such
  as `release/v2/v2.0`, writes the next major production version such as
  `v3.0.0`, points `publish-gate/major`, `release/v3/v3.0`, `v3.0`, and `v3`
  at that release commit, then prepares `v3.0.1-alpha.0` for
  `alpha/v3/v3.0`, `dev/v3/v3.0`, `v3.0-alpha`, and `v3-alpha`. The older `major-gate`
  branch name is a compatibility alias only.

The release branch name defines the minor line. For example,
`release/v2/v2.1` creates `v2.1.N`, promotes `v2.1`, and promotes `v2` only
when the next minor tag such as `v2.2` does not already exist.

The action updates version state in `lerna.json`, root `package.json`, and
workspace package manifests discovered from package manager metadata
(`package.json` workspaces, `lerna.json` packages, or `pnpm-workspace.yaml`).
Package manager detection is adaptive (`pnpm`, `npm`, or `yarn`) and is recorded
in logs.

Repositories can also provide `buildchain.toml` to declare version-state files
and `lifecycle.verify`. TOML-configured version files take precedence over
package-manager discovery and can target JSON, TOML, or regex-based files. The
version commit itself is written through the GitHub Git Data API so the ref
graph is the durable source of truth. Repositories without any supported version
state degrade to ref-only promotion only when strict version state is disabled.

JSON and TOML version entries whose declared key already matches the requested
version are treated as semantic no-ops. TOML changes use a parser-verified
lossless key edit, so repository formatting is preserved and formatter-only
release-preparation commits are not created. If a unique lossless edit cannot
be proven, promotion fails closed instead of rewriting the full TOML document.

## Dry Run

Use `dry-run: "true"` or the CLI `buildchain release --dry-run` before merging a
channel PR when you need to understand what Buildchain would do. This dry-run is
at the Buildchain release-line level. It explains:

- the legal source branch for the target channel;
- exact release or alpha tags that would be created or reused;
- floating tags and channel branches that would move;
- version-state files and verification lifecycle that would apply;
- branch protection, PR lineage, and release-from-alpha checks;
- publish transaction behavior when `lifecycle.publish` or
  `publish-transaction` is enabled.

It does not move refs, move tags, write package files, run publish commands, or
publish npm packages. The GitHub action dry-run still calls GitHub APIs to
resolve the current target SHA and concrete pending ref updates, but every
write is reported as a dry-run update.

Repositories whose package version is anchored to an explicitly selected
upstream release can opt into manual next-anchor behavior:

```toml
[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"
```

In this mode, the action validates the configured version files and anchor
manifest through the repository's verify lifecycle, but it does not rewrite the
package version to match the Buildchain release tag. After a production
release, it sets `next-anchor-required=true` and does not auto-create the next
alpha branch or tag. The repository must create the next upstream anchor line
explicitly, then run the normal channel promotion flow for that line.

When branch protection requires pull requests, generated version-state commits
still run through promotion automation first. The action updates
Buildchain-managed channel protection before generated bookkeeping, adds the
authenticated promotion token user or app to the bypass allowlist, creates the
configured required check on the exact generated version-state commit, then
tries to apply that commit directly. If GitHub still rejects release
finalization bookkeeping, Buildchain creates or reuses a same-repository
`buildchain/version-state/*` PR based on the current target channel head and
returns `finalization-needed=true`; a later idempotent promotion run can resume
from the durable transaction state. Strict alpha promotion still fails with a
configuration diagnostic instead of opening a post-publish human PR. Reusable
wrapper callers should allow `checks: write` so the generated check is owned by
GitHub Actions and matches the managed branch protection rule.

Stable promotion also protects concurrent development work. The reusable
wrapper checks out the exact current `dev/vN/vN.M` head as a reconciliation
workspace. If next-alpha bookkeeping cannot fast-forward that branch, the
action reruns the declared version-state generation and verification from that
dev tree, creates a two-parent reconciliation commit from the regenerated
files, and fails closed if the checkout moved before the mutation boundary.
This prevents generated projections from an older release tree from replacing
capabilities that reached dev while the release was in progress.

For Buildchain-owned automation, callers may pass
`branch-protection-bypass-apps`, `branch-protection-bypass-users`, or
`branch-protection-bypass-teams`. The action still configures managed
`dev/vN/vN.M`, `alpha/vN/vN.M`, and `release/vN/vN.M` branches with one
required approving review, strict GitHub Actions checks, admin enforcement,
conversation resolution, no force pushes, and no deletions; the bypass
allowance only lets the named automation identity apply generated version-state
or channel bookkeeping without a second human review after the reviewed channel
PR has already merged. Direct action calls automatically include the current
promotion token's authenticated user or app when GitHub exposes it; explicit
inputs are supplemental allowlist entries for less discoverable release
authorities.

## Publish Transactions

Promotion can also own external publish side effects. Enable this only from a
trusted channel workflow:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    generated-ref-update-token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ github.sha }}
    target-ref: release/v2/v2.0
    publish-transaction: "true"
    publish-mode: publish-final-version
    publish-auth: trusted-publishing
    publish-required-artifacts-json: >-
      [
        {"kind":"npm","name":"@kungfu-tech/buildchain","ref":"2.0.0","digest":"sha256:..."}
      ]
```

For anchored/manual package repositories that build through the reusable
workflow, keep the publish entrypoint on the `publish-gate/*` source-lock
contract:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ needs.build.outputs.publish-source-sha }}
    target-ref: release/v22/v22.22
    require-publish-source-lock: "true"
    publish-source-ref: ${{ needs.build.outputs.publish-source-ref }}
    publish-source-sha: ${{ needs.build.outputs.publish-source-sha }}
    publish-source-locked: ${{ needs.build.outputs.publish-source-locked }}
    publish-transaction: "true"
    publish-mode: publish-final-version
    publish-auth: trusted-publishing
```

`target-ref` remains the channel promotion target that must point at `sha`.
`publish-source-ref` is the reviewed source-lock branch that authorized this
specific package publication. Direct `alpha/*` or `release/*` channel refs are
not valid publish source locks when `require-publish-source-lock` is enabled,
and a mismatched `publish-source-sha` fails before any promotion or publish side effects begin.

Consumers that opt in to a product-owned final predicate set
`require-publication-qualification: "true"` and pass the exact sealed
`publication-capability-json`, complete `publication-gate-aggregate-json`, and
`publication-qualification-receipt-json`. The action validates their canonical
digests, predicate identity, freshness, nonce, source, version, channel, target,
and evidence bindings both before provider access and immediately before the
publish transaction. Missing or drifted receipts fail before mutation. The
reusable `release-candidate-promote.yml` workflow creates these values in a
separate credentialless consumer job; direct callers must preserve the same
contract and may pass previously consumed nonces through
`publication-used-qualification-nonces-json`.

The reusable promote workflow serializes non-dry-run promotion intents per
repository and re-reads `target-ref` before checkout, dependency installation,
release-candidate resolution, or publish-gate writes. If a queued intent asks
for an older SHA after the protected channel has advanced, the workflow records
the requested/current SHA pair, verifies that the current target is ahead of
the requested commit, and exits successfully as a superseded no-op. Diverged,
behind, or unreadable comparisons still fail closed.
After queued-intent revalidation, the reusable workflow runs the canonical
release-candidate resolver in metadata-only mode before installing candidate
dependencies or starting the full promotion job. The full job resolves and
downloads the evidence again before any publish-gate or publication mutation.
This preserves the final exact-evidence trust check while making missing or
stale PR-stage evidence fail early.
The action repeats that check at its mutation boundary for governed promotion
calls, closing the race between workflow preflight and action start. Direct
non-governed calls and dry-runs keep the strict target mismatch error so local
diagnostics cannot silently reinterpret a stale request.
Expected manual dry-run failures remain visible in the workflow result and do
not create automated workflow-friction issues; issue reporting is reserved for
non-dry-run promotion failures.
The reusable build workflow performs the cheaper channel-ref preflight earlier:
after source-lock resolution and before the build matrix, it requires the target
channel ref such as `alpha/v22/v22.22` or `release/v22/v22.22` to already point
at the locked `publish-source-sha`. If not, maintainers should merge the source
commit through the channel PR first.

For promote-only release candidates, attach the PR-stage reusable build evidence
and fail before publish-gate side effects if it no longer matches:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ needs.build.outputs.publish-source-sha }}
    target-ref: alpha/v22/v22.22
    promote-only-release-candidate: "true"
    release-candidate-passport-path: .buildchain/artifacts/release-candidate-passport.json
    release-candidate-build-summary-path: .buildchain/artifacts/build-summary.json
```

The action validates repository, channel, source identity, platform matrix, and
the aggregate build-summary hash before it writes version state, opens
release-state, runs publish transaction logic, or moves tags/branches. Source
identity accepts the exact source SHA, the PR merge ref SHA, or the promoted
channel HEAD's Git tree SHA matching the passport tree hash. If validation
fails, run or attach the verified channel PR build first instead of promoting a
stale or unproven artifact set.

When enabled, the action creates or resumes a release transaction keyed by
repository, version, source SHA, and target ref. It persists that transaction to
a machine-managed branch under `buildchain/release-state/<version>`, with
`state.json` and, once available, `evidence.json`. Fresh GitHub runners read
that durable ref before running publish, so reruns do not depend on a previous
runner's local `.buildchain` directory.

The action runs `lifecycle.publish` from `buildchain.toml` or the explicit
`publish-command` input, then validates publish evidence before exact tags and
floating refs move. If durable state persistence fails, the action fails closed
before publish or public ref finalization.

`publish-mode` defaults to `publish-final-version`, the token-free path for
normal npm Trusted Publishing. Same-version alpha-to-latest recovery must be
declared as `publish-mode: promote-existing-version` and
`publish-auth: npm-token`; Buildchain runs `npm whoami` before it creates
release-state or moves any `npm dist-tag`. The Trusted Publishing mode is not
allowed to perform `npm dist-tag add`.

Buildchain itself uses this path for npm. Its `lifecycle.publish` runs
`node scripts/npm-publish-transaction.mjs`, which publishes
`@kungfu-tech/buildchain` through npm Trusted Publishing and writes npm
artifact evidence into the transaction before release refs move. The separate
`.github/workflows/npm-publish.yml` workflow is dry-run only.

Publish lifecycle environment:

```text
BUILDCHAIN_VERSION
BUILDCHAIN_CHANNEL
BUILDCHAIN_SOURCE_SHA
BUILDCHAIN_TARGET_REF
BUILDCHAIN_RELEASE_STATE
BUILDCHAIN_EVIDENCE_DIR
BUILDCHAIN_RELEASE_SHA
BUILDCHAIN_RELEASE_MATERIAL_SHA
BUILDCHAIN_PUBLISH_TOOLING_SHA
BUILDCHAIN_PUBLISH_EVIDENCE
BUILDCHAIN_REQUIRED_ARTIFACTS
```

`BUILDCHAIN_REQUIRED_ARTIFACTS` is the normalized requirement array after the
action resolves a missing artifact `ref` to `BUILDCHAIN_VERSION`, or expands an
optional `ref_template` containing exactly one `{version}`, and binds any
declared provenance to the current release coordinate. Template expansion
happens after exact version selection; ambiguous or unsupported templates fail
before `lifecycle.publish`. Requirement descriptors may omit `digest`; final
publish evidence may not.

The action outputs `transaction-id`, `transaction-state`,
`transaction-exact-tag`, `public-release-tag`, `transaction-release-sha`,
`transaction-state-ref`, `transaction-state-sha`, `transaction-state-path`,
`publish-evidence-path`, and `release-passport-path`, `release-passport-output-dir`,
`release-passport-state-sha`, and `finalization-needed`.
`transaction-state-ref` is the durable recovery location.
`release-passport-state-sha` is the durable ref commit after the generated
`release-passport/*` files have been uploaded into that recovery ref.
`finalization-needed=true` means publish evidence is valid, but protected branch
or ref finalization needs a later idempotent promotion run. For release
finalization, Buildchain may create a same-repository generated version-state
PR when GitHub rejects the direct protected ref update; that PR is Buildchain
bookkeeping, not a consumer-authored release change.
Set `github-release: "true"` when the semver promotion should also publish the
public GitHub Release. After the release transaction reaches `complete` and
`finalization-needed` is false, the action creates or updates the GitHub Release
for `public-release-tag`, applies deterministic semver metadata
(`prerelease=true` and `make_latest=false` for prerelease tags, latest for stable
tags), and uploads the publish evidence file plus generated release passport
assets. For anchored/manual package releases, `public-release-tag` is derived
from the published package version, while `transaction-exact-tag` remains the
internal Buildchain transaction ref for recovery and audit. If the transaction is
not complete yet, the action defers GitHub Release publication to the next
idempotent promotion run.

After a publish transaction reaches `complete`, the action generates the unified
`buildchain-release-passport` in `.buildchain/release-passport` by default and
persists those files under `release-passport/` in the durable release-state ref.
Set `release-passport-product-name` to record the consumer product name, for
example `Libnode`, instead of the default `Buildchain`.
Set `release-passport-kfd-1-witness-jsons` to newline-separated KFD-1
contract-world witness JSON paths when released artifacts must prove
byte-for-byte KFD contract surfaces. Buildchain imports the KFD metadata from
`@kungfu-tech/kfd`, freezes the witness, verifies artifact bytes, and writes the
result under the KFD-provided `kfd-1` passport section.
Set `release-passport-kfd-2-claim-jsons` to newline-separated KFD-2 public
release trust claim JSON paths when a release makes additional human/agent
visible claims. Buildchain requires each public claim to bind declared sources,
machine-readable evidence, hashes, artifact coordinates, verification results,
audit boundary, responsibility state, and residual risk. Unbound claims fail
passport verification; prose-only claims downgrade the KFD-2 audit.
Set `release-passport-kfd-3-prebuild-witness-jsons` to newline-separated KFD-3
collaboration-interface pre-build witness paths, then provide artifact-side
evidence with `release-passport-kfd-3-artifact-witness-jsons` or a
product-owned `release-passport-kfd-3-artifact-verify-command` such as
`kungfu agent verify --json`. Buildchain compares declared shipped public
surfaces with artifact-exposed public surfaces and writes the result under the
KFD-provided `kfd-3` passport section.
Buildchain's own release workflow sets `release-passport-buildchain-self-kfd:
"true"`. In that mode the action generates Buildchain-owned KFD-1/2/3 witnesses
inside the final version-state workspace, after the release transaction has
materialized generated files such as `package.json` and `dist/site/*`. This
keeps self-hosted KFD witness hashes bound to the exact published package
instead of to a pre-promotion checkout.
When present, the passport includes the aggregate build summary, platform
artifact manifests, npm publish evidence, dist-tag promotion evidence, the
release-state ref, trusted publishing metadata, and the Buildchain transaction
result. After the first passport upload, Buildchain backfills the durable
release-state SHA into `buildchain.release.json` and persists the passport
again, so the consumer-side passport is a complete audit entrypoint. Set
`release-passport: "false"` only for a controlled recovery run that must skip
passport generation.

Finalization recovery is anchored to the durable transaction, not to a single
workflow run SHA. After generated version-state bookkeeping is applied, the
current channel head can be the generated version-state commit or a historical
merge commit that contains or corresponds to the recorded `release_material_sha`;
it does not have to equal the original `source_sha` or the transaction
`release_sha`. Reruns accept exact tags that already point at the transaction
release/material SHA or the finalized channel head, and continue moving any
missing floating tags or dev/alpha refs before marking the transaction
`complete`.

Normal reruns accept already-published artifacts only when evidence matches.
Missing required artifacts can be published on the next run. Conflicting
refs, digests, or declared provenance put the transaction into
`repair_required`; `abandoned` and
`failed_permanently` also fail closed unless `publish-transaction-override` is
set for a controlled repair. The same override may replace a stale transaction
only when its version, exact tag, target ref, and channel are unchanged, the
transaction is not complete, and it contains no published artifacts or
evidence. This lets a newly admitted source retry a previously failed paper
publication without weakening already-published facts.

In strict buildchain promotion, ref movement is also gated by the old ABV
governance semantics:

- when detailed target branch protection is readable, it must enforce
  protection for administrators and require approving PR review plus the strict
  `check` job from the `Verify` workflow; when GitHub withholds that
  administration endpoint from the workflow token, the exact transaction must
  instead prove a protected current head, same-repository merged PR,
  independent approval, and the required successful `check` from its configured
  GitHub App;
- post-publish channel reconciliation reuses an already qualifying
  provider-enforced policy when the workflow token cannot read or rewrite the
  administrative protection document, and fails closed if the public branch
  summary no longer carries the required check for everyone;
- alpha promotion must come from a merged same-repository PR
  `dev/vN/vN.M -> alpha/vN/vN.M`, or from a strict same-line
  `publish-gate/alpha/vN/vN.M/<version> -> alpha/vN/vN.M` source-lock PR;
- release promotion must come from a merged same-repository PR
  `alpha/vN/vN.M -> release/vN/vN.M`, or from a strict same-line
  `publish-gate/release/vN/vN.M/<version> -> release/vN/vN.M` source-lock PR;
- major promotion must come from a merged same-repository PR
  `release/vN/vN.M -> publish-gate/major`;
- release promotion must have an exact alpha tag for the same patch line, and
  the release source tree must match that alpha tag tree, so release does not
  introduce new code after alpha;
- anchored/manual release promotion may differ from that alpha tree only in
  declared `version.files` and the configured anchor manifest, and only when the
  checked-out release material has passed `lifecycle.verify` or the explicit
  `verification-command`;
- generated release and next-alpha version-state trees can be verified locally
  with either the `verification-command` input or `buildchain.toml`
  `lifecycle.verify` before any tags or channel refs move.

The promotion workflow should use `BUILDCHAIN_PROMOTION_TOKEN` for non-dry-run
promotion. The token is the buildchain equivalent of the old ABV runner release
authority: protected branch review and check rules guard human channel merges,
while the reusable build trust gate now checks the source-lock channel HEAD and
merged same-repository PR lineage before heavy build runners start. This action
still independently rechecks PR lineage, alpha/release tree equivalence, and
generated version-state verification before moving channel refs and tags.
Generated version-state direct ref updates can use a separate
`generated-ref-update-token`; the reusable wrapper defaults it to
`secrets.BUILDCHAIN_PROMOTION_TOKEN || github.token`. Consumers that protect
`dev/*`, `alpha/*`, or `release/*` with one required review should configure
`BUILDCHAIN_PROMOTION_TOKEN` as the bypass-capable release authority, so
post-publish dev/alpha/release bookkeeping completes without a human PR.
The reusable `release-candidate-promote.yml` wrapper defaults
`branch-protection-bypass-apps` to `github-actions`, so flow-internal promotion
can complete generated `dev`/`alpha`/`release` bookkeeping while ordinary human
pushes and PR merges remain governed by the one-review branch protection rule.
The promotion action also auto-discovers the current token's authenticated user
or app and adds it to the managed bypass allowlist, so consumers do not have to
declare the same release authority twice.

The tag names intentionally follow the old ABV release semantics:
exact release tags are `vX.Y.Z`, exact alpha tags are `vX.Y.Z-alpha.N`, floating
release tags are minor/major tags such as `v2.0` and `v2`, and floating alpha
tags are minor-line tags such as `v2.0-alpha` plus cross-minor major tags such
as `v2-alpha`. A major alpha tag only moves for the highest minor in that major
with a published alpha, so older-line maintenance cannot roll consumers back.
Bare tags such as `1.0.0` are not
maintained as buildchain release entrypoints.

Repository rulesets should protect exact tags, not every `v*` tag. A ruleset
such as `refs/tags/v*` also protects floating channel tags like `v2.0-alpha` and `v2-alpha`,
which Buildchain must update after exact tags and publish evidence are durable.
Use an exact-tag rule such as `refs/tags/v*.*.*` for immutable evidence tags and
leave floating channel tags mutable for the promotion token.
