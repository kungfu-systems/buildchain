---
status: draft
period: ongoing
theme: github-governance-authority
doc_type: protocol
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-30
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-30
  limits: Live GitHub state and account recovery remain provider-controlled and must be re-audited.
---

# GitHub Governance Authority

Buildchain treats GitHub governance as an independently verified, fail-closed
authority boundary. A green CI run, a CODEOWNERS file, an API success response,
or an administrator's assertion is not sufficient by itself. The verifier
combines the exact CODEOWNERS bytes from the target base branch, classic branch
protection, every applicable repository or organization ruleset, account role
classes, plan capability, required checks, and provider-read completeness into
one short-lived immutable receipt.

The machine contract is
`@kungfu-tech/buildchain/github-governance-authority`. Its policy root covers
the managed-zone repository and target-ref admission rules, the exact
required-check context/App bindings and strict-update semantics for every
public authoritative target, the dual-account authority split, protected
verifier paths, native review requirements, break-glass constraints, and the
explicit trust boundary.

## Trust boundary and non-claims

The trusted computing base contains GitHub service integrity, retained
organization-owner recovery custody, the `kungfu-origin` review/governance
identity, the exact Buildchain verifier, and official publication identities.
The protocol does not claim resistance to compromise of GitHub itself,
compromise of all retained owner and recovery anchors, or malicious control of
all independent trust anchors. A governance receipt grants no GitHub
permission and is not a bearer credential.

`dongkeren` is the development and pull-request author identity.
`kungfu-origin` is the independent Code Owner and governance identity. A
qualifying receipt requires the development identity to be active without an
administrator or maintainer role and requires the review identity to retain the
admitted governance role. Account recovery and retained root custody remain
outside normal contributor and workflow paths.

## Effective policy

The verifier evaluates native provider layers together. Every authoritative
target must require:

- a pull request, at least one independent Code Owner approval, and a fresh
  approval after the latest reviewable push;
- administrator enforcement, resolved review conversations, and a non-empty
  required-check set whose exact contexts, GitHub App producer identities, and
  strict-update setting match the versioned target policy;
- no unapproved bypass actor, force push, or protected-ref deletion. Managed
  dev/alpha/release ref bookkeeping may admit only the exact GitHub Actions App
  identity versioned for that target; user and team bypass actors remain
  non-qualifying;
- exact last-match ownership of CODEOWNERS and the governance descriptor,
  collector, rollout planner, and scheduled audit workflow;
- complete readable GitHub API evidence. Missing, forbidden, ambiguous, or
  malformed provider state is non-qualifying.

Repository and organization rulesets are additive to classic branch
protection. Inspecting only one layer is insufficient because an applicable
bypass or weaker update path in another layer can invalidate the effective
policy.

When an admitted default development branch uses GitHub merge queue, its
candidate-source, queue-lease, and final build checks are one exact authority
set. The queue lease may remain intentionally unbound while workflow-produced
checks retain their GitHub Actions App binding; strictness must match the live
queue ruleset.

## Repository and plan admission

The 2026-07-30 baseline contains 16 managed public repositories. The descriptor
sets `managedVisibilities` to `public`; private repositories are outside the
managed-zone inventory and do not produce governance receipts. Public
repository names are versioned in the descriptor. A newly discovered public
repository or target ref is non-authoritative until explicitly admitted.

The descriptor also versions every active public merge target. The full audit
evaluates one receipt per authoritative target rather than assuming the default
branch represents dev, alpha, release, or major publish-gate branches. The live
default branch is always included even if it drifts outside the registry, in
which case it is non-qualifying. Retained historical channels and generated
per-release publish-gate refs are not silently deleted or promoted to current
authority; they require an explicit registry revision before they can qualify.

Public repositories can qualify on supported Free, Team, or Enterprise
enforcement. Organization-wide rules require Team or Enterprise capability.
The verifier does not reinterpret an excluded private repository as qualifying,
replace missing native enforcement with CI or documentation, or make a private
repository public as a workaround.

## Read-only audit

Run the organization audit without mutation:

```bash
buildchain audit github-governance \
  --organization kungfu-systems \
  --output github-governance.json \
  --json
```

Limit a canary to one repository:

```bash
buildchain audit github-governance \
  --repository kungfu-systems/buildchain \
  --target-ref dev/v3/v3.0 \
  --require-qualifying \
  --json
```

Protected merge and publication consumers verify the receipt against the exact
repository, target base ref, policy root, freshness window, and exact
Buildchain verifier source revision. Non-dry-run publication does not trust a
caller-supplied JSON hash: it mints a bounded token for the dedicated read-only
governance auditor GitHub App, recollects live provider state with the exact
Buildchain runtime, requires the resulting single-repository/single-target
audit to qualify, and consumes that independently generated receipt. Missing
App configuration or unreadable provider state denies publication before
provider mutation. The publication authority workflow is itself an explicit
Code Owner path.

The publication authority job and every reusable-workflow caller grant the
built-in `GITHUB_TOKEN` only `actions: read`, `checks: read`, `contents: read`,
and `pull-requests: read`. The dedicated auditor App independently recollects
the organization-wide governance receipt, while these job-scoped permissions
allow the exact publication transaction audit to resolve required check runs
and merged pull-request review lineage. Omitting either read permission makes
the transaction evidence incomplete and therefore non-qualifying.

The output is sanitized. Managed public repositories retain their public
identity. Excluded private repositories produce no receipt or diagnostic.
Tokens, cookies, recovery material, private CODEOWNERS bytes, raw permission
payloads, and credential-bearing URLs are never included.

## Mutation and rollback boundary

Live role, ruleset, branch-protection, Actions, Environment, or repository
changes are separate from audit. Every mutation starts from a read-only
inventory and a frozen rollback snapshot. A rollout plan binds both roots and
lists the exact API operation, impact, expected observation, and inverse
operation. Apply must stop on the first unexplained drift and must perform a
post-change read-back before continuing to the next bounded canary.

Plan one exact branch without mutation:

```bash
buildchain github-governance plan \
  --repository kungfu-systems/buildchain \
  --branch dev/v3/v3.0 \
  --required-check check \
  --required-check-app-id check=15368 \
  --required-approvals 1 \
  --snapshot-output rollback.json \
  --plan-output rollout.json
```

An already protected check preserves its observed GitHub App binding. Every new
required check must declare `--required-check-app-id <context>=<app-id>`;
context-only replacement is rejected because it would broaden which producer
can satisfy the gate.

Classic branch-protection bypass allowances and ruleset bypass actors are both
part of the effective policy. Reconciliation writes explicit empty user, team,
and App bypass lists and verifies those lists after apply; omitting the provider
field is not treated as removal because GitHub may preserve the prior value.

The plan prints a `planRoot`. Apply requires that exact root and stops if live
protection no longer matches the frozen inventory:

```bash
buildchain github-governance apply \
  --plan-json rollout.json \
  --confirm-plan-root sha256:...
```

Rollback is separately explicit and root-bound:

```bash
buildchain github-governance rollback \
  --plan-json rollout.json \
  --confirm-rollback-root sha256:...
```

For an admitted exact target, classic branch protection can also be compiled
directly from the authority descriptor. This mode preserves both App-bound
checks and intentionally unbound check contexts such as Kungfu release's
legacy `build`, rather than guessing a provider App identity.

```bash
buildchain github-governance protection-policy-plan \
  --repository kungfu-systems/kungfu \
  --branch alpha/v4/v4.0 \
  --snapshot-output protection-rollback.json \
  --plan-output protection-rollout.json

buildchain github-governance protection-policy-apply \
  --plan-json protection-rollout.json \
  --confirm-plan-root sha256:...

buildchain github-governance protection-policy-rollback \
  --plan-json protection-rollout.json \
  --confirm-rollback-root sha256:...
```

For an admitted exact target, repository ruleset reconciliation compiles the
target descriptor into the provider body. It replaces bypass actors with the
exact provider-admitted desired set, requires fresh Code Owner approval and
resolved review threads, and binds required checks plus strict-update semantics
to the target policy. Newly synthesized managed rules include GitHub's explicit
canonical defaults so the frozen expected root matches provider read-back.
Repository rulesets default to no bypass actors. The
descriptor's target-bound GitHub Actions allowance is an upper bound on
effective provider state, not a requirement to add that actor to every
protection layer; when needed, the built-in App allowance is expressed by
classic branch protection. The target condition must contain exactly one
branch; unrelated rules and conditions are preserved in place.

```bash
buildchain github-governance ruleset-policy-plan \
  --repository kungfu-systems/buildchain \
  --branch alpha/v2/v2.14 \
  --ruleset-id 19518955 \
  --snapshot-output ruleset-rollback.json \
  --plan-output ruleset-rollout.json

buildchain github-governance ruleset-policy-apply \
  --plan-json ruleset-rollout.json \
  --confirm-plan-root sha256:...

buildchain github-governance ruleset-policy-rollback \
  --plan-json ruleset-rollout.json \
  --confirm-rollback-root sha256:...
```

The narrower `ruleset-plan` mode changes only `bypass_actors`; it remains
available for a bypass-only canary, but it cannot prove that an effective
ruleset matches the target descriptor. Both modes require the frozen ruleset
snapshot root for rollback.

Paid-plan purchase, billing, legal/account-owner decisions, and any operation
that could remove the last recoverable owner remain external human gates.
Break-glass is disabled by default and, if ever admitted, must be separately
authenticated, reason-bound, time-bounded, independently receipted, and
followed by mandatory restoration and root comparison.
