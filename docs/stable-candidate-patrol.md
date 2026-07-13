---
status: preview
period: ongoing
theme: stable-candidate-patrol
doc_type: architecture-and-usage
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-11
  visible_context: Buildchain candidate passport, stable gate, Patrol, publish transaction, exact source-lock PR contracts, tests, and user consensus.
  invisible_context_boundary: No credentials, private logs, or unpublished consumer content were used.
---

# Stable Candidate Patrol

Buildchain can treat every exact alpha as an independent stable candidate. A
new alpha creates a new candidate; it does not silently revoke an older alpha
that already completed its checks and soak interval.

## Candidate lifecycle

The durable ledger contract is `kungfu-buildchain-stable-candidate-ledger`:

```text
registered -> soaking -> qualified -> promoted
                       \-> revoked
```

Each entry binds an exact alpha version to one immutable commit SHA. Registering
the same version at another SHA fails closed. Qualification records the required
checks, their completion times, the derived soak start, and elapsed time.

Scheduled selection chooses the newest `qualified` candidate that is neither
`revoked` nor already `promoted`. A newer alpha that is still `soaking` does not
hide an older qualified candidate. Once a stable version is promoted, remaining
alphas for that exact stable version are closed because that immutable stable
version has been consumed; their later product changes continue through the
next patch alpha prepared by the normal release transaction.

For Buildchain's own release line, successful Alpha Self-Dogfood starts an
idempotent qualification producer for the exact alpha SHA. It dispatches the
existing `Build Surface Fixture` at the immutable exact tag, runs the existing
`site-libkungfu-dev` no-apply canary with the exact SHA, and writes the declared
commit-status attestation only after that authoritative canary succeeds. The
producer creates evidence only: Patrol still owns qualification and selection,
and the normal source-lock PR, stable gate, transaction, and branch protections
remain mandatory.

Cross-repository dispatch and repository-local attestation use separate tokens.
The promotion token can start the no-apply consumer workflow, while the
repository-scoped Actions token writes the status as `github-actions[bot]` only
after the producer has observed the successful authoritative workflow run. The
stable gate still verifies the workflow identity, exact runtime SHA, target URL,
and allowed attestor before accepting that status.

## Repository policy

Declare the default once in `.buildchain/buildchain.toml`:

```toml
[release.stable]
strategy = "latest-qualified-alpha"
timezone = "Asia/Shanghai"
publish_at = "03:00"
minimum_soak_seconds = 3600
required_checks = [
  "alpha-release",
  "workflow:Build",
  "status:buildchain-canary/consumer",
]
auto_promote = true
auto_merge = true
```

Check identifiers use these forms:

- `alpha-release`: the exact GitHub prerelease publication fact;
- `workflow:<name>`: a successful Actions workflow run on the exact candidate SHA;
- `status:<context>`: a successful commit status on the exact candidate SHA;
- an unprefixed value: an exact status context or check-run name.

Candidate discovery uses immutable exact alpha Git tags. When a repository also
publishes GitHub prereleases, `alpha-release` binds qualification to that public
release fact. Repositories that intentionally disable GitHub Releases omit
`alpha-release` and declare their own exact-SHA workflow/status evidence; tag
commit time remains the earliest possible soak start.

`publish_at` and `timezone` are the auditable policy declaration. GitHub only
starts scheduled workflows from caller-owned cron, so the thin caller keeps the
matching UTC trigger:

```yaml
name: Stable Candidate Patrol

on:
  schedule:
    - cron: "0 19 * * *" # 03:00 Asia/Shanghai
  workflow_dispatch:
    inputs:
      release-now:
        description: Exact alpha selected by explicit human authority
        required: false
        default: ""

permissions:
  contents: write
  pull-requests: write
  checks: read
  statuses: read

jobs:
  stable:
    uses: kungfu-systems/buildchain/.github/workflows/stable-candidate-patrol.yml@v2
    with:
      release-now: ${{ inputs.release-now }}
      dry-run: false
    secrets:
      promotion-token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
```

The promotion token must be repository-owned and capable of creating the
machine ledger branch, exact source-lock branch, and pull request. Repositories
that require an approving review can set `auto-approve: true` only when their
GitHub Actions policy explicitly allows the caller token to approve the PR;
otherwise a repository-owned App or review bot supplies the approval. The
generated PR may use auto-merge, but it never bypasses the target branch checks.

Before enabling `auto-approve` and `auto-merge`, the caller repository must
enable both corresponding GitHub capabilities:

- **Actions > General > Workflow permissions > Allow GitHub Actions to create
  and approve pull requests**, so the caller `github.token` can provide the
  approval independently from the promotion token that opened the PR;
- **General > Pull Requests > Allow auto-merge**, so Patrol can arm the
  protected merge while required reviews and checks are still pending.

Patrol treats a GraphQL refusal to enable auto-merge as a hard failure. A run
must not report publication authority when GitHub accepted the HTTP request but
returned a GraphQL error in the response body.

## Exact-source stable promotion

For a selected `2.12.0-alpha.4`, Patrol creates the immutable source branch:

```text
publish-gate/release/v2/v2.12/2.12.0-alpha.4
```

and opens it against `release/v2/v2.12`. This is an existing strict Buildchain
governance path. The PR freezes the qualified candidate even if `v2.12-alpha`
or `alpha/v2/v2.12` has already moved to alpha.5. Normal Verify,
release-candidate resolution, source-tree equivalence, publish transaction,
passport, registry, tag, and floating-ref checks still run.

## Hold, revoke, and immediate release

Persistent repository controls can be supplied as reusable-workflow inputs or
repository variables:

```text
BUILDCHAIN_STABLE_HOLD=true
BUILDCHAIN_STABLE_HOLD_REASON=release freeze
BUILDCHAIN_STABLE_REVOKED_ALPHA_VERSIONS=2.12.0-alpha.5,2.12.0-alpha.7
BUILDCHAIN_STABLE_REVOKE_REASON=consumer regression
```

Revocation is explicit evidence; publishing a newer alpha alone is not
revocation. A manual `workflow_dispatch` `release-now` chooses one exact,
non-revoked candidate immediately. It may bypass the scheduled soak decision,
but cannot change candidate SHA, reuse a consumed stable version, or bypass the
source-lock PR and publish transaction.

For Buildchain's own stable gate, Patrol automatically projects that explicit
human decision into the exact-candidate `BUILDCHAIN_STABLE_RELEASE_NOW` and
reason variables. A later Patrol run removes them after it observes the public
stable release. This is an internal compatibility projection, not a manual user
step; the durable authority record remains the candidate ledger entry and PR.

## Durable recovery

The default ledger ref is derived from the release line, for example:

```text
buildchain/candidate-ledger/v2/v2.12
```

It stores `.buildchain/stable-candidate-ledger.json`. Patrol runs are serialized
per repository and release line. Repeated runs reuse the same exact source-lock
branch and PR, while later runs observe the public stable release and mark the
candidate `promoted`.

When Patrol is enabled after a stable version already exists, it reconstructs
that consumed patch from GitHub Release truth and closes historical alpha
candidates for the same stable version. It never attempts to republish an
already claimed exact stable version.
