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
last_reviewed: 2026-07-24
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-24
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
the managed-zone admission rules, the dual-account authority split, protected
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
  exact required-check set;
- no unapproved bypass actor, force push, or protected-ref deletion;
- exact last-match ownership of CODEOWNERS and the governance descriptor,
  collector, rollout planner, and scheduled audit workflow;
- complete readable GitHub API evidence. Missing, forbidden, ambiguous, or
  malformed provider state is non-qualifying.

Repository and organization rulesets are additive to classic branch
protection. Inspecting only one layer is insufficient because an applicable
bypass or weaker update path in another layer can invalidate the effective
policy.

## Repository and plan admission

The 2026-07-24 baseline contains 16 managed repositories: 13 public and three
private. Public repository names are versioned in the descriptor. Private
repository names are never emitted in public evidence; their identities are
represented by roots. A newly discovered repository is non-authoritative until
explicitly admitted.

Public repositories can qualify on supported Free, Team, or Enterprise
enforcement. Private repositories and organization-wide rules require Team or
Enterprise capability. On an unsupported plan they remain explicitly
`non-authoritative-plan-capability-required` and publication-ineligible. The
verifier does not replace missing native enforcement with CI or documentation,
and the implementation never makes a private repository public as a
workaround.

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
  --target-ref dev/v2/v2.14 \
  --require-qualifying \
  --json
```

Protected merge and publication consumers verify the receipt against the exact
repository, target base ref, policy root, freshness window, and exact
Buildchain verifier source revision. The publication authority workflow is
itself an explicit Code Owner path. A receipt from another ref or verifier
revision cannot authorize a later publication.

The output is sanitized. Public repositories retain their public identity.
Private repositories expose only an identity root, visibility class, target
ref, fact roots, and a qualifying or non-qualifying decision. Tokens, cookies,
recovery material, private CODEOWNERS bytes, raw permission payloads, and
credential-bearing URLs are never included.

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
  --branch dev/v2/v2.14 \
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

Paid-plan purchase, billing, legal/account-owner decisions, and any operation
that could remove the last recoverable owner remain external human gates.
Break-glass is disabled by default and, if ever admitted, must be separately
authenticated, reason-bound, time-bounded, independently receipted, and
followed by mandatory restoration and root comparison.
