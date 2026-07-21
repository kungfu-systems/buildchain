---
status: draft
period: ongoing
theme: observed-evidence-patrol
doc_type: contract
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-21
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-21
  invisible_context_boundary: No credentials, private logs, or unpublished evidence values are included.
---

# Observed Evidence Patrol

Observed Evidence Patrol publishes a reproducible public observation without
creating a content PR for every refresh. It is for derived evidence whose
meaning is fully checked by the caller and whose publication safety can be
decided mechanically.

The caller generates a `kungfu-buildchain-observed-evidence-bundle`. The bundle
binds one `snapshot.id` to two byte-identical JSON files:

- a versioned immutable object such as
  `dogfood-evidence/snapshots/<snapshotId>.json`;
- a mutable last-known-good alias such as `dogfood-evidence.json`.

Buildchain verifies both file digests and snapshot identities before receiving
production authority. Apply then performs this order:

1. conditionally create the immutable key with `If-None-Match: *`;
2. read the immutable key back and verify its declared SHA-256 metadata;
3. record the previous latest metadata as the rollback pointer;
4. atomically replace the latest object;
5. read latest back and verify the same snapshot and digest;
6. invalidate only the declared viewer paths.

Any generator, schema, digest, immutable-key, provider, or read-after-write
failure leaves the previous latest object in place. A colliding immutable key
is reusable only when both snapshot identity and SHA-256 match; otherwise the
run fails without overwriting it.

## Trust boundary

The reusable workflow admits only `schedule` or `workflow_dispatch` events on
the caller repository's default branch. It checks out that branch explicitly,
does not persist Git credentials, and never runs pull-request or fork code. The
consumer owns its evidence semantics through the build and verify commands;
Buildchain owns publication ordering and provider safety.

Production OIDC authority should be a dedicated role and Environment with no
review gate for steady-state refreshes. Its policy should allow only:

- `s3:GetObject` and `s3:PutObject` on the exact latest key;
- the same actions on the exact immutable snapshot prefix;
- `cloudfront:CreateInvalidation` on the one distribution.

It must not receive bucket-wide delete, list, repository write, GitHub PR, or
general deployment authority. One-time workflow, IAM, schema, and page changes
still use normal review and release governance.

## Ordinary site releases

A site artifact that contains
`.buildchain/observed-evidence-ownership.json` declares the paths owned by the
Patrol channel. Web-surface deploy adds those paths to the S3 sync exclusion
set, so a later full-site release cannot delete the snapshot archive or replace
latest with an older build fixture. The HTML page should project the latest
JSON at runtime, retaining its committed copy only as an explicitly labelled
fallback.

## Rollback and recovery

Every receipt records the previous latest snapshot id, digest, ETag, and S3
version id when available. Rollback regenerates a bundle whose latest file is
the selected immutable snapshot and republishes it through the same validator;
operators do not edit or delete immutable history. If CDN invalidation fails
after latest advances, rerunning the same bundle is idempotent and repairs edge
convergence.
