---
status: draft
period: 2026-08-07
theme: buildchain-v4-canonical-contracts
doc_type: technical-reference
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
  visible_context: Protected Buildchain v4 architecture, canonical contract implementations, schemas, and cross-language fixtures.
  invisible_context_boundary: Did not inspect credentials, private logs, hidden model state, or unobserved production behavior.
---

# Buildchain v4 canonical contracts

Buildchain v4 uses one provider-free contract layer for deterministic state-machine bytes and roots. TypeScript v3 remains the sole production writer. These contracts introduce no Git ref writer, network or filesystem effect, daemon, database, credential owner, or ambient clock.

## Canonical JSON v1

`buildchain-canonical-json/v1` accepts only JSON values. Object keys must be non-empty printable ASCII and are ordered by ascending ASCII code point. Arrays retain input order. Numbers are base-10 integers in the inclusive JavaScript-safe range `-9007199254740991..9007199254740991`; fractions, negative zero, non-finite numbers, and wider integers are rejected. Strings use JSON escaping and UTF-8. The exact output ends with one LF byte.

Content roots hash these exact bytes with an explicit domain separator:

```text
sha256(ASCII(domain) + NUL + canonical-json-bytes)
```

The only v1 domains are `queue-state`, `candidate-identity`, `fencing-token`, `transition-receipt`, `observation`, `semantic-diff`, and `bootstrap-evidence`. A queue-state root is computed from a value that omits its own `stateRoot` field.

## Explicit clocks and closed envelopes

Pure contract code accepts time only as `YYYY-MM-DDTHH:mm:ss.SSSZ`. An adapter samples once and passes the value as data. Missing clocks, offsets, invalid calendar instants, or other precision are rejected.

Event, receipt, and typed-fault objects use closed versioned shapes in [`contracts/v4-canonical-contracts-v1.schema.json`](../contracts/v4-canonical-contracts-v1.schema.json). Unknown fields fail. Only a rejected receipt carries a typed fault; accepted and no-op receipts carry `null`.

## Implementations and proof

- JavaScript: [`packages/core/v4-canonical-contracts.js`](../packages/core/v4-canonical-contracts.js)
- Rust: [`crates/buildchain-v4-contracts`](../crates/buildchain-v4-contracts)
- Shared golden and adversarial cases: [`architecture/v4-canonical-contract-fixtures.json`](../architecture/v4-canonical-contract-fixtures.json)

Run the focused proof with:

```sh
pnpm run check:v4-contracts
```

The check validates both implementations, compares exact UTF-8 bytes and SHA-256 roots, exercises invalid numbers, keys, clocks, domains, and envelope shapes, and scans the pure libraries for ambient clock or provider imports. Delivery Warrant decide/fold, shadow invocation, provider effects, and production authority remain outside this contract slice.

## Shared Delivery Warrant fixture runner

The versioned trace contract in [`contracts/v4-delivery-warrant-trace-v1.schema.json`](../contracts/v4-delivery-warrant-trace-v1.schema.json) is the language-neutral boundary for retained Delivery Warrant fixtures. The JavaScript runner in [`packages/core/v4-delivery-warrant-fixture-runner.js`](../packages/core/v4-delivery-warrant-fixture-runner.js) and the Rust runner in [`crates/buildchain-v4-contracts`](../crates/buildchain-v4-contracts) consume the same UTF-8 fixture bytes and emit the same deterministic semantic projection.

Each trace is closed and ordered. It binds the exact prior root, event, action or typed fault, canonical successor bytes and root, generation, fencing counter, ordered declarative effects, provider-neutral observations, and rooted receipt. The runner verifies the full root chain before returning a projection. Malformed JSON, missing or unknown fields, reordered sequences, stale roots, and unsupported contract versions fail closed.

The retained public-safe fixtures are:

- [`golden.json`](../contracts/fixtures/v4-delivery-warrant-trace-v1/golden.json) for accepted submit/select transitions and ordered effects;
- [`replay.json`](../contracts/fixtures/v4-delivery-warrant-trace-v1/replay.json) for a stale-fence typed fault and response-loss readback.

The runner is not a state-machine implementation and does not sample time, execute effects, access Git/GitHub, or move production authority. TypeScript v3 remains the sole production writer. Later Rust decide/fold and TypeScript shadow adapters supply or consume this contract instead of defining another projection shape.

## TypeScript shadow adapter

The adapter in [`packages/core/v4-delivery-warrant-shadow-adapter.js`](../packages/core/v4-delivery-warrant-shadow-adapter.js) runs the existing TypeScript v3 fixture projection first and preserves that exact result as the only authoritative output. When explicitly enabled, it sends the same canonical input bytes to the replaceable Rust host command, requires the effect-disabled host capability, and captures the returned semantic projection only as a non-authoritative observation. Rust never receives effect authority, and success, failure, timeout, cancellation, malformed output, or an unsupported host cannot change the v3 result.

Shadow retention accepts only checked-in fixtures or captured replays explicitly marked public-safe. Each returned observation binds the input root, exact TypeScript and Rust source revisions, validator version, capture time, fixed retention deadline, both projections, and sanitized diagnostics. It contains no comparison verdict or cutover signal. The adapter is disabled unless the caller opts in or sets `BUILDCHAIN_V4_WARRANT_SHADOW=enabled`; even then, invalid source bindings or an unsafe retention class skip Rust invocation.

## Pure Rust Delivery Warrant domain

The `warrant` module in [`crates/buildchain-v4-contracts`](../crates/buildchain-v4-contracts) implements the protected Delivery Warrant manifest as provider-free typed state, seven event decisions, and a separate fold. It freezes all nine candidate states and all nine primitives from the shadow bootstrap plan. Every decision binds the event's exact `subjectRoot`, takes time only from the validated event envelope, and returns a typed action or fault. Fold produces a canonical successor; the combined transition produces only ordered `persist-successor` and `request-admission` intents plus a rooted receipt. It never executes either intent.

Duplicate submission deliberately retains the legacy generation/root mutation for shadow comparability. Manifest aliases remain explicit, waiting and blocked remain valid states without invented public transitions, and response-loss reconciliation is symmetric for every declarative effect. Stale expected-old roots and fences, lease expiry, terminal duplicates, cancellation, response loss, provider conflict, and retry exhaustion are closed typed outcomes. The retry policy permits at most one reread/redecision and then stops.

The domain consumes the same retained golden and replay bytes as the shared runner. Focused tests cover deterministic replay, bounded property sequences, duplicate behavior, stale compare-and-set and fencing, lease recovery/reselection, settlement and cancellation idempotence, response loss, provider conflict, and calendar-boundary clock arithmetic. Repository-level architecture tests reject provider and I/O imports, ambient clocks, process execution, hidden writers, and unbounded retry loops. The manifest still names `typescript-v3` as the sole authoritative writer with a zero second-writer budget; this slice adds no shadow routing, effect adapter, read/write cutover, or production authority.
