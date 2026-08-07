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
