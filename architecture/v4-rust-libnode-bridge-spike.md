---
status: draft
period: 2026-08-07
theme: buildchain-v4-rust-libnode-bridge
doc_type: architecture-evaluation
source_level: local-files + protected-git-evidence
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-07
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  boundary: Uses repository source, executable fixtures, and a local darwin-arm64 measurement; it does not claim unexecuted platform parity or a final v4 ABI.
---

# Buildchain v4 Rust/libnode bridge spike

## Decision

Wave 0 selects a Rust-trunk to Node-compatible subprocess host behind the
closed, versioned
[`v4-host-contract-v1.schema.json`](../contracts/v4-host-contract-v1.schema.json).
The Rust trunk owns transport bounds, correlation, timeout, cancellation,
child cleanup, crash classification, and compatibility output. The MJS adapter
continues to call the existing read-only TypeScript implementation. All
production writers remain TypeScript v3.

The host is replaceable through explicit executable and adapter coordinates;
the Rust code does not import libnode, Node, V8, provider SDK, or private
runtime types. The exact option matrix, retained fixtures, source revisions,
and captured measurements are machine-readable in
[`v4-rust-libnode-bridge-evaluation.json`](v4-rust-libnode-bridge-evaluation.json).

## Contract

Requests carry only a command identity, string arguments, canonical base64
input bytes, required capabilities, a timeout, and a correlation id. Responses
carry a structured result, byte-exact stdout and stderr, typed diagnostics,
exit code and signal semantics, and the capabilities actually offered by the
host. Both documents are closed objects. Credential fields and private runtime
layouts therefore fail before host execution.

Unsupported commands, capabilities, and protocol versions are explicit rather
than silently downgraded. `compat` mode unwraps the response and reproduces the
legacy process stdout, stderr, and exit code; `exchange` mode returns the full
structured response.

## Compared boundaries

| Boundary | Wave 0 result | Evidence |
| --- | --- | --- |
| Rust process directly embeds libnode's C++ API | Rejected for Wave 0 | The exact libnode source exposes compiler `libpath`/`include` coordinates and Node's C++ embedding lifecycle, but no versioned C ABI that owns initialization, event-loop execution, cancellation, and teardown. A new shim would bind Rust to Node/V8 ABI and failure-domain details. |
| Rust process spawns a Node-compatible contract host | Selected | Implemented with bounded pipes and a closed protocol; the retained suite proves CLI/JSON parity, structured results, controlled failure, large input, unsupported behavior, timeout, signal cancellation, cleanup, and host crash classification. |

The in-process result is falsifiable: reconsider it when libnode publishes a
versioned C ABI shim that owns the complete lifecycle and accepts and returns
only the frozen byte-oriented host contract. A benchmark alone is insufficient
because it would not remove the ABI, teardown, crash-domain, and portability
risks.

## Reproduce

```bash
pnpm bridge:v4:build
pnpm bridge:v4:run -- architecture.list -- --json
pnpm run bridge:v4:evidence -- --iterations 7
pnpm run check:v4-bridge
node --test tests/v4-bridge.test.mjs
```

Set `BUILDCHAIN_LIBNODE_ROOT` only when collecting optional local libnode
revision and artifact-size evidence. Its path is never written into the
contract or committed evaluation.

## Limits

The darwin-arm64 probe observed a roughly 19.4 ms median increment over direct
Node host startup and a 768,544-byte release Rust binary. These seven samples
are a boundary cost observation, not a final performance or ABI decision.
Linux and Windows remain required validation targets before any consumer or
writer migration. This spike creates no daemon, credential broker, mutable
cross-machine store, or second state authority.
