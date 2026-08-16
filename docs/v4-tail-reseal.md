# V4 retained-candidate tail reseal

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
- Only `macos-arm64:signing-finalization` may change payload bytes. The public
  workflow verifies the retained macOS bytes before the effect and verifies the
  resealed bytes plus signing and release-tail readbacks afterward.
- The signing token exists only in the macOS credential-island step. It is not
  stored in a Capsule, request, artifact, log, Passport, or receipt.
- A successful run emits the existing
  `kungfu-buildchain-release-candidate-passport` contract. Tail reseal does not
  create a second candidate or release artifact class.
- Durable callers use `@v4-alpha` during Alpha evaluation or `@v4` after stable
  promotion. Exact SHAs are runtime evidence from `job.workflow_sha`, never a
  persisted selector.

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

## Reusable workflow

Consumers invoke
`kungfu-systems/buildchain/.github/workflows/v4-tail-reseal.yml@v4-alpha` from a
trusted, same-repository workflow. The caller supplies the rooted request, the
original candidate consumer-policy receipt, a reviewed macOS finalization
command, and the explicitly named signing secret. The command must write:

- `.buildchain/tail-reseal/signing-provider-readback.json`
- `.buildchain/tail-reseal/release-tail-provider-readback.json`

Their byte digests must equal the roots fixed in the request. The workflow
downloads the signing result by exact authority repository, run, artifact name,
and archive digest; no credential or provider effect is replayed from a Stage
Capsule.

The v3-to-v4 invariant mapping is recorded in
[`architecture/v4-tail-reseal-parity.json`](../architecture/v4-tail-reseal-parity.json).
