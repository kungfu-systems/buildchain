---
status: draft
period: ongoing
theme: buildchain-release-tail-contract
doc_type: architecture
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-09
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-09
  visible_context: Current Buildchain 4.1 workflow and action graph, promotion request schemas, provider transaction implementation and retained historical inventory.
  invisible_context_boundary: Did not read credentials, private logs, signed URLs, provider state, or unpublished release assets.
---

# Declarative release-tail contract

The current machine authority is
[`architecture/release-tail-contract.json`](../architecture/release-tail-contract.json).
The public promotion workflow accepts one typed request, then dispatches
QUALIFY, APPLY and SETTLE. APPLY reaches the canonical provider transaction;
it cannot forward arbitrary publication, activation, commit or evidence commands.
The declaration schema is
[`contracts/release-tail-capabilities-v1.schema.json`](../contracts/release-tail-capabilities-v1.schema.json),
and provider behavior is documented in [release-tail-provider-plane.md](release-tail-provider-plane.md).

## Current executable boundaries

Four separately owned command surfaces remain outside the canonical promotion
transaction: consumer admission predicates, the direct ref-promotion Action's
publication command, product evidence preparation, and version-state verification.
Their nine workflow, Action, config and CLI coordinates have five execution sites.
The checker verifies the current Paper and publication-authority callers against
the actual composite Action graph. These are current contracts with no historical
aliases, migration window or fallback execution path.

The direct ref-promotion Action accepts `release-passport-attachment-command` for
product attachments. Its old evidence-command alias is removed. Canonical public
promotion uses typed publication data and does not call that separate Action.

The exact old managed-consumer snapshot remains in
[`release-tail-contract-inventory.json`](../architecture/release-tail-contract-inventory.json)
as historical evidence. It grants no current execution or compatibility authority;
this change makes no claim about updating those external repositories.

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

## Publication identity

Published tags, assets, package coordinates, signed channel documents, Passports
and receipts remain immutable. Current declarations create their own transactions;
they never reinterpret settled history. No compatibility reader or migration
exception is used to admit a current request.

## Failure rules

The contract fails closed when:

- a reverse scan discovers an unregistered command-bearing release-tail input;
- one name maps to multiple capabilities;
- an effect lacks stable operation identity;
- a mutation lacks readback and receipt contracts;
- local retry is unbounded;
- an alias or compatibility fallback is introduced into the current contract.

Run the contract check with:

```bash
node scripts/check-release-tail-contract.mjs
node --test tests/release-tail-contract.test.mjs
```

The tests mutate the inventory and declaration fixtures to prove that orphaned
hooks, ambiguous ownership, embedded commands, missing identity/readback,
unbounded retry, command aliases and compatibility fallbacks are rejected.
