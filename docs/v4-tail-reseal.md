---
status: active
period: ongoing
theme: retained-candidate-tail-reseal
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Internal tail-reseal contract, workflow taxonomy and shared recovery entry.
  invisible_context_boundary: No hosted recovery or publication is claimed.
---

# Internal retained-candidate tail reseal

Consumers recover through `buildchain-recover.yml` with an exact attempt and an
optional repaired runtime. The request schema, ports and commands below describe
internal mechanisms; they are not consumer setup or recovery inputs.

Buildchain v4 can recover one narrowly defined late Alpha failure without
rebuilding a qualified four-platform candidate. The recovery is not a cache hit
and does not give Stage Capsule any provider authority. It is a fresh governed
run that proves all retained bytes first, then executes only the explicitly
fenced macOS signing-finalization tail.

The authoritative request schema is
[`contracts/v4-tail-reseal-v1.schema.json`](../contracts/v4-tail-reseal-v1.schema.json).
It binds the failed run and source tree, four payload and manifest archive
digests, four content roots, Stage Capsule roots and reuse decisions, Warrant
lineage, retention, credential authority, signing delegation/result, release
tail transaction, idempotency key, and independent provider readbacks. Any
mismatch rejects reuse and requires a normal candidate build.

## Authority boundary

- `install`, `build`, `verify`, `package`, and the ordinary platform matrix are
  skipped only when all 16 per-platform Stage Capsule decisions prove exact
  reuse. Capsule reuse has no external effects.
- Only `macos-arm64:signing-finalization` may change payload bytes. The internal
  component verifies the retained macOS bytes before the effect and verifies the
  resealed bytes plus signing and release-tail readbacks afterward.
- The signing token exists only in the macOS credential-island step. It is not
  stored in a Capsule, request, artifact, log, Passport, or receipt.
- A successful run emits the existing
  `kungfu-buildchain-release-candidate-passport` contract. Tail reseal does not
  create a second candidate or release artifact class.
## CLI and Node API

Plan locally from the deterministic data contract:

```sh
buildchain tail-reseal plan \
  --request .buildchain/tail-reseal/request.json \
  --output .buildchain/tail-reseal/plan.json
```

`tail-reseal admit` performs the provider readback of the exact failed run,
jobs, retained GitHub artifact archives, and signing-authority result. Each
fresh platform runner then uses `verify-platform --mode retained`. Only the
macOS runner may follow with `--mode resealed --provider-readback-root ...`.
After the ordinary Release Candidate Passport is generated, `tail-reseal seal`
binds all four readbacks and the protected Warrant readback into the final
receipt.

The Node exports are `@kungfu-tech/buildchain/v4-tail-reseal` for request and
plan logic and `@kungfu-tech/buildchain/v4-tail-reseal-receipt` for terminal
receipt creation and verification.

## Internal component

`.ops-tail-reseal.yml` receives the runtime-admitted rooted request, original
candidate policy receipt and explicitly scoped signing authority. Only its
admitted signing-finalization tail may issue the provider effect. Its readback
files bind the exact signing and release-tail provider roots. The component
downloads retained material by exact authority identity and digest; a Stage
Capsule cannot replay credentials or provider authority.

Consumers do not supply a signing command or call this component directly.

The v3-to-v4 invariant mapping is recorded in
[`architecture/tail-reseal-parity.json`](../architecture/tail-reseal-parity.json).
