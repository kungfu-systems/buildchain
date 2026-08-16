# Declarative Release Tail

This Action executes the versioned `buildchain.release-tail/v1` declaration
through one durable Buildchain transaction. It accepts only data bindings for
sealed artifacts, rooted JSON documents, HTTP provider endpoints and released
evidence inputs. It does not accept a command, script, executable path, plugin
or repository callback.

Every mutation is preceded and followed by provider readback. Buildchain core,
not the adapter, compares the observed subject and target roots, owns retry and
terminal classification, checkpoints state and emits the standardized receipt.
Tokens remain Action inputs and are never written to the transaction or
receipt.

When `rehearsal-capsule` is supplied, the same Action switches to the v4
Publication Rehearsal Capsule boundary. `simulate` and `replay` remain
effect-disabled. `provider` additionally requires exact capsule-bound
rehearsal authority, consumes only the capsule-rooted data bindings, and
records every request/readback while still emitting
`productionAuthority: false` and no Release Passport. See
[`docs/v4-publication-rehearsal.md`](../../docs/v4-publication-rehearsal.md).
