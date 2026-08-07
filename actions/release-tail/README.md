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
