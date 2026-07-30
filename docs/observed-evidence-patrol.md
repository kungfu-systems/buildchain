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
last_reviewed: 2026-07-30
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-30
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

The bundle may also declare up to 16 derived mutable projections under
`publication.projections`. Each projection declares its artifact-relative
`source`, bounded destination `key`, exact `sha256`, `contentType`, and
`cacheControl`. This supports static HTML such as `dogfood/index.html` without
changing the existing immutable/latest JSON contract.

Buildchain verifies both file digests and snapshot identities before receiving
production authority. Apply then performs this order:

1. conditionally create the immutable key with `If-None-Match: *`;
2. read the immutable key back and verify its declared SHA-256 metadata;
3. record preceding version metadata for every declared mutable key;
4. write and read back each derived projection in manifest order;
5. atomically replace the latest object;
6. read latest back and verify the same snapshot and digest;
7. invalidate only the declared viewer paths.

Projection-enabled publication requires bucket versioning before replacing an
existing mutable key. If a later projection, latest update, or invalidation
fails, Buildchain restores preceding object versions in reverse order and
removes newly introduced declared projection keys. Rollback never lists the
bucket and never touches keys outside the manifest.

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
- for projection-enabled bundles, `s3:GetObjectVersion` and bounded
  `s3:DeleteObject` on the exact declared mutable keys;
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

Every receipt records the previous latest and projection snapshot ids, digests,
ETags, and S3 version ids when available. A projection transaction rolls back
automatically when a later mutable step or CDN invalidation fails. Operators
can also regenerate a bundle whose latest file is the selected immutable
snapshot and republish it through the same validator; immutable history is
never overwritten or deleted. Legacy bundles without projections retain their
existing idempotent rerun behavior when CDN invalidation alone fails.
