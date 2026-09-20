---
status: preview
period: ongoing
theme: stable-candidate-patrol
doc_type: architecture-and-usage
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: User-directed zero-delay self release policy, required provider evidence and regression tests.
  invisible_context_boundary: No credentials, private logs, or unpublished consumer content were used.
---

# Stable Candidate Patrol

This page describes the retained internal `.ops-stable-candidate-patrol.yml`
mechanism. Current consumer release intent is a legal channel PR through the
normal pipeline. Consumers do not add a scheduled stable caller or provider-token
inputs. The policy and ledger fields below belong to internal or historical
qualification, not schema-2 TOML extensions.

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
idempotent qualification producer for the exact published alpha runtime. The
producer validates the public `build.yml@v4-alpha` run and its build summary:
consumer source and run attempt must match, all three platforms must complete
the install/build/verify lifecycle, and a transient runtime override is rejected.
It writes `buildchain-canary/buildchain-zero-input` on the qualified runtime SHA
as `github-actions[bot]`. The consumer source SHA may differ from that runtime.

The repository Patrol policy requires the alpha Release and this qualification
status. Its minimum soak and stable publication interval are both zero.
The publication transaction still requires
its sealed release candidate and protected branch checks. Qualification produces
evidence; it does not publish or merge a candidate.

The standalone stable gate declares this canary as `public-build`. It reads the
status target's exact repository-owned workflow run, verifies the provider digest
of its uniquely named summary artifact, and applies the same summary validator
as the producer. It then enforces the allowed attestor and soak policy. A green
status with a foreign run, another candidate, an override or incomplete platform
evidence cannot qualify a release. The gate also retains its release-candidate
check and stable publication interval.

After publishing a new alpha, refresh the consumer alpha contract lock and run
the unchanged zero-input Alpha Self-Dogfood entry. Entry changes are qualified by
the newly published `@v4-alpha`; train validation remains a separate transient
runtime path and does not qualify this release canary.

## Repository policy

Declare the default once in `.buildchain/buildchain.toml`:

```toml
[release.stable]
strategy = "latest-qualified-alpha"
timezone = "Asia/Shanghai"
publish_at = "03:00"
minimum_soak_seconds = 0
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

The retained scheduling policy does not add a consumer-owned cron workflow.
Any internal patrol mutation must use independently admitted write authority,
revalidate its exact candidate and honor protected reviews/checks. An HTTP-success
response with GraphQL errors is not accepted publication or landing authority.

## Exact-source stable promotion

For a selected `4.0.2-alpha.4`, Patrol creates the immutable source branch:

```text
publish-gate/release/v4/v4.0/4.0.2-alpha.4
```

and opens it against `release/v4/v4.0`. This is an existing strict Buildchain
governance path. The PR freezes the qualified candidate even if `v4.0-alpha`
or `alpha/v4/v4.0` has already moved to alpha.5. Normal Verify,
release-candidate resolution, source-tree equivalence, publish transaction,
passport, registry, tag, and floating-ref checks still run.

## Hold, revoke, and immediate release

The internal component retains these persistent control ports:

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
buildchain/candidate-ledger/v4/v4.0
```

It stores `.buildchain/stable-candidate-ledger.json`. Patrol runs are serialized
per repository and release line. Repeated runs reuse the same exact source-lock
branch and PR, while later runs observe the public stable release and mark the
candidate `promoted`.

When Patrol is enabled after a stable version already exists, it reconstructs
that consumed patch from GitHub Release truth and closes historical alpha
candidates for the same stable version. It never attempts to republish an
already claimed exact stable version.
