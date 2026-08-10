---
status: preview
period: 2026-08-08
theme: buildchain-publication-rehearsal
doc_type: product-manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-08
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-08
  visible_context: Public rehearsal capsule runtime, release-tail provider plane, CLI, Action, workflow, and generated consumer surfaces.
  invisible_context_boundary: No credentials, private provider state, signed URLs, or external publication receipts were read.
---

# Publication rehearsal

Buildchain publication rehearsal runs the deterministic release tail locally
from one `kungfu.buildchain.publication-rehearsal-capsule/v1` document. The
normative rule is [ADR 0001](../architecture/decisions/0001-release-local-constructibility.md):
every non-external release behavior must be locally constructible, and no
semantic path may depend on GitHub runner state.

The machine-readable shape is
[`publication-rehearsal-capsule-v1.schema.json`](../contracts/publication-rehearsal-capsule-v1.schema.json).

## Exact local command

Run from the repository root after restoring the content-addressed candidate:

```sh
buildchain release-tail rehearse \
  --capsule "$PWD/.buildchain/publication/rehearsal-capsule.json" \
  --capsule-root "$PWD/.buildchain/publication/candidate" \
  --mode simulate \
  --state "$PWD/.buildchain/publication/rehearsal-state.json" \
  --evidence "$PWD/.buildchain/publication/rehearsal-evidence.json"
```

Use `--mode replay` only when the capsule contains a complete recorded
provider-response sequence. Both modes produce rooted evidence with
`externalPublicationClaimed: false`.

## Daily fixture and sealed-candidate modes

For daily development, build a synthetic capsule with
`createPublicationRehearsalCapsule`, use synthetic files and provider
observations, and run `--mode simulate` or `--mode replay`. This fixture mode is
for deterministic regression evidence only.

Before publication qualification, restore the exact sealed candidate bytes,
Passport, policy roots, initial transaction and recorded observations named by
the retained capsule, then run the exact command above. Preserve the resulting
binding root, transaction root, state root, receipt roots and evidence root.
These roots qualify deterministic construction only; external publication and
public readback still require their own authorities.

## Capsule contents

The capsule root commits to the release-tail declaration, ordered policy roots,
Passport path/root, initial durable transaction, complete file inventory,
data-only provider bindings, recorded observations, portable platform policy,
declared environment keys, and the exact list of external effects. Every input
file is a regular non-symlink file under the explicit absolute capsule root and
must match its size and SHA-256 root.

The CLI never reads `GITHUB_*`, infers a runner workspace, selects behavior from
`process.platform`, or accepts executable hooks. An explicit environment JSON
object must match the capsule declaration exactly.

## Hosted parity

The reusable `release-tail.yml` workflow passes the explicit capsule to the
`actions/release-tail` wrapper. The wrapper supplies only GitHub/HTTP transport
and declared secret inputs, then invokes the same
`executePublicationRehearsal` public core used locally. Provider requests,
responses, failures, transaction roots, receipt roots, and the final evidence
root are retained together.

Simulation or replay is development evidence. Provider mode can record real
external observations, but it still does not replace Release Passport,
attestation, registry, activation, public-readback, or protected-delivery
authority.

## Failure handling

Diagnostics use
`kungfu.buildchain.publication-rehearsal-diagnostic/v1`. Preserve the capsule,
diagnostic root, binding root, and exact failed files. Repair the shared core or
capsule locally and rerun before spending another hosted runner attempt.
