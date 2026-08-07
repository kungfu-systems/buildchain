# Declarative Release Tail

This Action restores one content-addressed
`kungfu.buildchain.publication-rehearsal-capsule/v1` and invokes the same public
rehearsal runtime used by the local CLI. The capsule binds the versioned
`buildchain.release-tail/v1` declaration, candidate files, policies, Passport,
transaction, data-only provider bindings and observations. It does not accept
a command, script, executable path, plugin, repository callback, implicit
workspace or GitHub runner semantic input.

Every mutation is preceded and followed by provider readback. Buildchain core,
not the adapter, compares the observed subject and target roots, owns retry and
terminal classification, checkpoints state and emits the standardized receipt.
Tokens remain Action inputs and are never written to the transaction or
receipt. The wrapper contributes only credentials, GitHub/HTTPS transport and
real provider observations. The rooted provider transcript and rehearsal
evidence are retained with the transaction state.
