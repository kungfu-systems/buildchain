---
status: draft
period: 2026-08-07
theme: buildchain-release-tail-contract
doc_type: architecture
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-07
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  visible_context: Buildchain dev/v3/v3.0 release workflows, promotion Action, transaction and activation code, local exact-head managed-consumer callers, and the Kungfu alpha release-tail implementation.
  invisible_context_boundary: Did not read credentials, private logs, signed URLs, provider state, or unpublished release assets.
---

# Declarative release-tail contract

Buildchain v3 currently lets a consumer repository provide shell commands at
several points around publication. Those hooks made early adoption possible,
but they also let a consumer redefine the final release transaction. The
machine authority for the current inventory is
[`architecture/release-tail-contract-inventory.json`](../architecture/release-tail-contract-inventory.json).
The declaration schema is
[`contracts/release-tail-capabilities-v1.schema.json`](../contracts/release-tail-capabilities-v1.schema.json).

This contract freezes the replacement boundary. It does not cut over a
consumer, run a release, or reinterpret an already published release.

## Current executable surfaces

The reverse scan classifies 27 workflow, Action, config, and CLI coordinates
into seven owned surface groups:

| Surface                                                                  | Current role                                              | Replacement                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| `publication-gate-command`, `publication-consumer-qualification-command` | Consumer-owned admission and predicate logic              | Buildchain-evaluated declarative predicates                 |
| `publish-command`, `lifecycle.publish`                                   | Artifact/package materialization and provider publication | `artifact.publish`                                          |
| KFD-3, invariant Passport, and attachment commands                       | Product-specific evidence generation                      | Typed evidence requirements and Buildchain-owned projectors |
| `publication-commit-command`                                             | Final signed or well-known channel authority move         | `signed-channel.commit`                                     |
| `release-activation-command`                                             | Site activation and production readback                   | `release.activate`                                          |
| reusable-workflow `release-passport-evidence-command`                    | Receipt-only released-evidence synthesis                  | `released-evidence.synthesize`                              |
| Action `verification-command`                                            | Version-state verification before release-tail execution  | Separate version-state contract; not part of release tail   |

One name is already ambiguous. In the reusable promotion workflow,
`release-passport-evidence-command` means post-activation released-evidence
synthesis. In the lower-level promotion Action, the same name is a deprecated
alias for `release-passport-attachment-command`. New declarations reject that
cross-layer alias collision instead of preserving it as a permanent escape
hatch.

The current v3 managed-caller snapshot covers Buildchain self-bootstrap, both
Buildchain paper release paths, Kungfu, Libnode, KFD, and the Kungfu product
white paper. The inventory binds every snapshot to an exact commit, tree,
workflow path, runtime ref, and the executable surface groups it uses. The
legacy `agent-hub-demo@v2` caller is recorded but excluded from the v3 contract.

## Capability declaration

A declaration contains data, never repository shell. Four capability ids cover
the current Kungfu alpha tail:

1. `artifact.publish` publishes exact artifact roles to a declared destination.
2. `signed-channel.commit` moves a signed channel authority only after artifact
   and Passport prerequisites are durable.
3. `release.activate` applies the production activation policy and evaluates
   declared public readback predicates.
4. `released-evidence.synthesize` consumes the validated activation receipt set
   and deterministically projects released evidence.

Every capability declares:

- artifact roles and content roots;
- destination, channel/tag, activation, and readback policy;
- standardized effect, observation, and receipt schemas;
- stable transaction, subject, target, capability, and attempt identity;
- idempotency behavior and a bounded local retry class;
- exact evidence requirements.

Keys named `command`, `cmd`, `script`, `shell`, or `run` are forbidden anywhere
in the declaration. Provider adapters may translate a rooted effect into API
calls, read providers, and return observations. They may not select state
transitions, change identity, synthesize success, or execute repository-owned
shell.

The checked fixture
[`kungfu-alpha.json`](../contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json)
represents the current Kungfu flow: public release assets, the Ed25519-signed
Alpha channel document, production status/acquisition/product readback, and
released-evidence synthesis from five canonical activation receipts.

## One release transaction

`buildchain.release-tail/v1` is the only owner of the tail lifecycle:

```text
prepare
  -> publish artifacts
  -> commit signed channel authority
  -> activate
  -> read back every declared predicate
  -> settle receipts and released evidence
  -> complete | blocked | repair-required | terminal-failure
```

Each effect uses one stable operation identity. A duplicate attempt performs
readback before any retry. `never`, `readback`, and `provider-transient` are the
only retry classes, and no local executor may exceed three attempts. Provider
conflict, identity drift, missing readback, and exhausted retry remain explicit
terminal classifications; an adapter cannot convert them into success.

## Compatibility and migration

The compatibility window begins when
`train/v3/v3.0/release-tail-contract` is published. It closes at the earlier of
90 days or the first v3.2 stable release, and spans at most two minor lines.

During that window:

- previously published tags, assets, packages, signed channel documents,
  Passports, and receipts remain immutable;
- only the exact enumerated callers may use the legacy adapter;
- every exception has an owner, the common expiry, and a removal test;
- migrated declarations create new transactions and never reinterpret settled
  history;
- no new arbitrary command input or generic plugin is accepted.

Cutover order is the Buildchain paper callers plus a self-bootstrap no-command
regression, Kungfu's complete Alpha tail, Libnode evidence generation,
KFD/white-paper no-command regression, then deletion of the Action alias and
all remaining command inputs. This card
defines that order only; consumer migrations are separate changes.

## Failure rules

The contract fails closed when:

- a reverse scan discovers an unregistered command-bearing release-tail input;
- one name maps to multiple capabilities;
- an effect lacks stable operation identity;
- a mutation lacks readback and receipt contracts;
- local retry is unbounded;
- an exception lacks an owner, expiry, or executable removal test.

Run the contract check with:

```bash
node scripts/check-release-tail-contract.mjs
node --test tests/release-tail-contract.test.mjs
```

The tests mutate the inventory and declaration fixtures to prove that orphaned
hooks, ambiguous ownership, embedded commands, missing identity/readback,
unbounded retry, and permanent escape hatches are rejected.
