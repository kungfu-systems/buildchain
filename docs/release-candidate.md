# Release Candidate Passport

The release-candidate passport is the pre-promotion evidence contract produced
after a reusable build matrix succeeds and before any publish-gate side effects
run. It is different from the release passport:

- `release-candidate-passport.json` proves which source SHA, channel, runtime,
  workflow run, and platform artifacts were verified before promotion.
- `buildchain.release.json` is generated after publish finalization and remains
  the durable audit entrypoint for the published release.

Enable it on the reusable build workflow:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v3
    with:
      artifact-name: libnode
      release-candidate: true
      publish-channel: alpha
      publish-source-ref: publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.7
```

When the platform matrix and aggregate summaries complete, Buildchain uploads:

```text
<artifact-name>-release-candidate-<publish-source-sha>
```

The passport contract is `kungfu-buildchain-release-candidate-passport`. It
contains:

- repository and pull request context;
- target channel, target ref, and product version or a non-publish
  `source-<shortSha>` candidate label;
- source head SHA, merge ref SHA, and the Git `HEAD^{tree}` SHA for PR merge
  equivalence after the channel PR lands;
- Buildchain runtime ref/SHA and workflow shell ref;
- workflow run id/attempt/url;
- normalized platform matrix and artifact summaries;
- the hash of the aggregate `build-summary.json`.

## Initiative-family release evidence

A consumer may pass `release-candidate-family-evidence-json` to the reusable
build. Buildchain normalizes that value as
`kungfu-buildchain-initiative-family-release-evidence/v1`, binds it into the
candidate hash, and carries it unchanged into publication authority. The
envelope can identify one Initiative family root plus the exact Initiative and
Assignment responsible for the release; continuation evidence can also bind
the previous family root.

This is an adapter-edge release contract, not a second Work Control authority.
The immutable native Family State v1 projection and the additive Family State
v2 typed envelope remain owned by Kungfu. Buildchain only proves that the
release candidate consumed the caller-supplied family evidence exactly.

Promotion workflows that should not rebuild artifacts can enable:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v3
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ needs.build.outputs.publish-source-sha }}
    target-ref: alpha/v22/v22.22
    promote-only-release-candidate: "true"
    release-candidate-passport-path: .buildchain/artifacts/release-candidate-passport.json
    release-candidate-build-summary-path: .buildchain/artifacts/build-summary.json
    release-candidate-family-evidence-required: "true"
    release-candidate-family-evidence-root: sha256:<initiative-family-root>
    release-candidate-family-initiative-id: 2026-07-30-example-initiative
    release-candidate-family-assignment-id: 2026-07-30-example-release
```

With `promote-only-release-candidate: "true"`, promotion fails before
version-state, publish transaction, tag, or branch side effects when the
passport does not match the repository, channel, source identity, platform
matrix, or build-summary hash. Source identity accepts the exact PR source SHA,
the PR merge ref SHA, or an exact Git tree match with the promoted channel HEAD;
this keeps post-merge channel commits strict without forcing a rebuild. The
Buildchain-owned promotion workflow resolves the matching same-repository
merged channel PR and downloads its PR-stage RC passport automatically before
promotion starts. The consumer wrapper defaults to a PR-stage workflow file
named `build.yml` with display name `Build`, and filters the RC passport and
build summary by the configured `artifact-name` before promotion. It also
downloads payload artifacts from the same PR-stage run, validates the required
payload count, passes downloaded platform manifests into the release passport,
and either forwards an explicit `publish-required-artifacts-json` value or
generates one before calling `promote-buildchain-ref`. Before that call, the
wrapper creates or updates `publish-gate/{alpha,release,major}` to the
promotion channel commit and passes that ref, target SHA, and `locked=true` to
the promote action with `require-publish-source-lock: "true"`. Consumers using
floating `@v3` therefore get publish-side source-lock drift protection without
copying resolver or promote YAML. The default npm path
generates that requirement list from the downloaded `.tgz` payloads themselves:
Buildchain reads `package/package.json` inside each tarball for the real scoped
package name and version, computes npm-style `sha512-...` integrity over the
tarball bytes, marks `publish-package-main` as `role: main`, and marks every
other package as `role: platform`. Consumer workflows therefore stay
declarative and do not need their own artifact download or publish-evidence
generation scripts.

When `release-candidate-family-evidence-required` is true, the promotion
boundary additionally requires the exact family root and may require the
Initiative and Assignment ids. Missing, mismatched, or source-drifted family
evidence fails before version-state, release-state, tag, or branch mutation.

Because a channel merge can trigger promotion before its PR-stage matrix has
finished uploading evidence, the resolver waits up to ten minutes for the exact
merged PR's successful workflow run and paired artifacts. Polling remains bound
to the PR/head identity; timeout or a sibling run still fails closed.

The public promotion router preserves the requested `vN` or `vN-alpha` ref as
audit metadata, but binds the router to GitHub's selected reusable-workflow SHA
and resolves each remaining floating shell/runtime ref exactly once. Every
later checkout and delegated promotion receives those immutable SHAs, so a
channel tag moving during the run cannot mix two Buildchain revisions.

## Resume from an existing candidate run

Do not rely on `gh run rerun` after a reusable-workflow startup or router
failure. GitHub documents two different rerun behaviors: a full rerun may use a
called workflow from the currently specified ref, while a failed-job rerun uses
the same called-workflow commit as the original attempt. Neither operation is a
supported way to create a job graph that GitHub failed to resolve at startup.
See GitHub's [reusable workflow rerun behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs)
and [workflow rerun identity rules](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

The supported recovery boundary is a new `workflow_dispatch` (or another new
caller event) that invokes `release-candidate-promote.yml` and supplies the old
candidate run explicitly:

```yaml
name: Resume release candidate
on:
  workflow_dispatch:
    inputs:
      candidate-run-id: { required: true, type: string }
      target-sha: { required: true, type: string }
      expected-tree: { required: true, type: string }
      candidate-runtime-sha: { required: true, type: string }
      buildchain-runtime-sha: { required: true, type: string }

jobs:
  resume:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@<exact-current-buildchain-sha>
    permissions:
      actions: write
      checks: write
      contents: write
      id-token: write
      pull-requests: write
    secrets: inherit
    with:
      buildchain-ref: ${{ inputs.buildchain-runtime-sha }}
      channel: alpha
      target-ref: alpha/v3/v3.0
      target-sha: ${{ inputs.target-sha }}
      artifact-name: product
      artifact-patterns: product-package-*
      release-candidate-workflow-file: build.yml
      release-candidate-workflow-name: Build
      resume-candidate-repository: ${{ github.repository }}
      resume-candidate-run-id: ${{ inputs.candidate-run-id }}
      resume-expected-workflow-file: build.yml
      resume-expected-workflow-name: Build
      resume-expected-source-tree: ${{ inputs.expected-tree }}
      resume-expected-candidate-runtime-sha: ${{ inputs.candidate-runtime-sha }}
      resume-buildchain-runtime-sha: ${{ inputs.buildchain-runtime-sha }}
      publish-transaction-override: true
```

`resume-expected-candidate-root` may replace `resume-expected-source-tree`, or
callers may provide both. `resume-transaction-id` is optional; when supplied it
must identify an already durable transaction before any provider mutation.

Recovery downloads and checks the successful `pull_request` run, active
workflow file and name, same-repository merged PR, trusted repository
association, target ancestry, promotion tree, Passport candidate root,
build-summary root, controller receipts, platform matrix, artifact archive
size/digest, every manifest file, and every product payload byte. Tree equality
alone is never admission. A different promotion commit is allowed only when all
of those identities still agree.

The recovery path conditionally skips consumer dependency installation and all
product `install`, `build`, `verify`, and platform-matrix jobs. It restores the
downloaded bytes as a content-addressed sealed bundle, so npm publication uses
the original `.tgz`. Both the explicit recovery entry and durable-transaction
re-resolution bind the bundle identity to the original candidate runtime
recorded in the Passport; a newer recovery tooling SHA is recorded only in the
recovery evidence and cannot perturb the durable payload root. Recovery may
regenerate only Buildchain-owned receipts,
attestations, signatures, Release Passport data, publication, and readback.

Success emits `kungfu-buildchain-release-candidate-recovery/v1` with
`action: reused`, the original run/source/tree, candidate and artifact roots,
the skipped stages, current tooling SHA, transaction identity/state, and an
exact receipt root. The receipt is uploaded as an Actions artifact and staged
with immutable GitHub Release Passport assets.

The original candidate Passport is never rewritten when a reusable fixture or
consumer build records a product version different from the sealed publication
package. In that case the promote action validates the Passport without
discarding its original target, then requires the immutable recovery receipt to
bind the original candidate root and source/tree to the exact version read from
the sealed payload. Without that receipt, the existing direct Passport version
check remains mandatory; receipt, candidate-root, target, or version drift fails
before publication side effects.

Missing or expired artifacts, archive or payload digest drift, tree/root,
repository/workflow/channel/target mismatch, untrusted run/PR provenance,
incomplete controller evidence, and transaction conflict fail closed with an
error code and next action. Buildchain never converts recovery failure into a
hidden full rebuild. A repository owner must choose a new candidate build
explicitly.

When a durable transaction is absent, recovery seals one from the verified
candidate. Existing `sealed`, `publishing`, `package-published`, `finalizing`,
and `complete` transactions use the normal idempotent state machine. Matching
registry and GitHub bytes are preserved, only missing publication work is
performed, and conflicting public digests enter `repair_required`.

By default, the wrapper forwards GitHub Release publication to the underlying
`promote-buildchain-ref` semver model. Once the release transaction is complete,
the action creates or updates the public GitHub Release, applies
prerelease/latest metadata from the authoritative publication channel (falling
back to semver tag syntax only for ordinary callers without that intent), and
uploads the publish evidence file together with the generated release passport
assets. This keeps
npm/registry publication, Buildchain release passport persistence, and
`release.published` propagation in one declarative reusable workflow. Consumers
that do not publish GitHub Releases can opt out with `github-release: false`.
For anchored/manual package releases, the public GitHub Release tag defaults to
`v<publishedVersion>` while the internal transaction exact tag remains recorded
in the release passport.

Standalone binary publication is a separate consumer capability. The promotion
wrapper does not assume that an npm-only repository provides
`.github/workflows/binary-distribution.yml`. Repositories that own that workflow
opt in with `standalone-binary-distribution: true`; Buildchain's self-promotion
does so explicitly. Once enabled, a missing or invalid binary workflow remains a
hard failure rather than being silently skipped.

Products that publish KFD release trust evidence can keep that path declarative
too. Pass KFD-1 self contract witnesses, KFD-2 public claim files, and KFD-3
pre-build/artifact evidence into the wrapper:

```yaml
jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3
    with:
      buildchain-channel: auto
      buildchain-alpha-contract-lock-path: .buildchain/alpha-contract-lock.json
      buildchain-stable-contract-lock-path: .buildchain/contract-lock.json
      channel: alpha
      artifact-name: libnode
      release-passport-kfd-1-witness-jsons: .buildchain/kfd/kfd-1/standard-contract.witness.json
      release-passport-kfd-2-claim-jsons: .buildchain/kfd/kfd-2/release-claims.json
      release-passport-kfd-3-prebuild-witness-jsons: .buildchain/kfd/kfd-3/collaboration-interface.prebuild.json
      release-passport-kfd-3-artifact-verify-command: kungfu agent verify --json
```

Buildchain forwards those declarations into `promote-buildchain-ref`, verifies
KFD-1 source/artifact contract surfaces, audits KFD-2 public release claims, and
compares KFD-3 declared shipped public surfaces with artifact-exposed public
surfaces. The release passport records the results under `kfd-1`, `kfd-2`, and
the KFD-provided `kfd-3` section.

Managed consumers may also ask the promotion wrapper to assemble sealed
publication evidence from the exact release candidate instead of producing
short-lived admission JSON in repository-specific workflow code:

```yaml
      publication-auto-admission: true
      publication-auto-no-gate: true
      publication-publisher-workflow-path: .github/workflows/buildchain-ref-promotion.yml
      publication-product: Example Product
      publication-target: npm:@example/product
      publication-package-name: "@example/product"
```

`publication-auto-no-gate` is an explicit consumer decision, not a default. A
consumer with a Shifu Gate registry either supplies
`publication-gate-aggregate-json`, or supplies a source-controlled
`publication-gate-command` that writes the aggregate to
`BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH`. The command runs from the exact
consumer source in the credential-free sealed-authority job, after Buildchain
has downloaded the exact RC passport, summary, controller receipt, manifests,
and payload bytes. It can read those inputs through
`BUILDCHAIN_PUBLICATION_EVIDENCE_ROOT`; it receives no publication token, OIDC
permission, or provider write permission. Buildchain validates the aggregate
digest and exact source binding before it seals a capability. Exactly one of
the supplied aggregate, consumer command, or explicit no-Gate decision is
allowed. Buildchain still requires caller-owned RC evidence, an exact authority
runtime and source SHA, a repository-local publisher workflow, matching npm
target/package identity or exact caller-bound GitHub Release target, and a
qualifying control-plane audit.

Promotion resolves the complete PR-stage workflow, not only the first required
status job that becomes green. `release-candidate-wait-seconds` bounds that
wait and defaults to three hours so long native builds can finish controller,
publication-tail, and retained-evidence jobs without racing a merged promotion.
An incomplete or failed workflow still fails closed; the longer bound does not
turn a partial required-check result into candidate evidence.

GitHub-Release-only consumers use the same managed admission without inventing
an npm package identity:

```yaml
      publication-auto-admission: true
      publication-auto-no-gate: true
      publication-publisher-workflow-path: .github/workflows/buildchain-ref-promotion.yml
      publication-product: Example Binary
      publication-target: github-release:example/example-binary
      publication-package-name: ""
```

The target must exactly match the caller repository. Buildchain audits the
job-scoped GitHub token, exact release-candidate payloads and manifests,
protected channel lineage, and public release transaction before allowing the
GitHub Release mutation.

A consumer that owns additional product qualification semantics can opt in to
the sealed handoff without teaching Buildchain those semantics:

```yaml
      publication-consumer-predicate-id: kungfu.release-admission/v1
      publication-consumer-qualification-command: node scripts/qualify-release.mjs
```

The command reads `BUILDCHAIN_PUBLICATION_CAPABILITY_PATH` and
`BUILDCHAIN_PUBLICATION_GATE_AGGREGATE_PATH`, evaluates the complete aggregate,
and writes a decision JSON document to
`BUILDCHAIN_PUBLICATION_QUALIFICATION_RESULT_PATH`. It also receives
`BUILDCHAIN_PUBLICATION_PREDICATE_ID` and
`BUILDCHAIN_PUBLICATION_PREDICATE_DIGEST`. The separate qualification job has
no write or OIDC permission and does not inherit publication secrets. A
successful deterministic receipt is rechecked by the provider action
immediately before mutation. Omitting both inputs preserves the existing
consumer contract; supplying only one fails closed.
