---
status: draft
period: 2026-07-31
theme: buildchain-v2-v3-parity
doc_type: engineering-retrospective
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-31
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-31
  invisible_context_boundary: Provider credentials, private logs, and unpublished consumer state were not inspected.
---

# Buildchain v2 to v3 Parity Closure — 2026-07-31

This record defines the reviewed v2-to-v3 convergence boundary. It treats
parity as a semantic requirement, not a raw branch merge: active v2 capability,
protocol, tests, and operator guidance must exist on v3, while retired
workflows, immutable historical projections, old release bookkeeping, and
superseded product-specific gates must not be revived.

## Reviewed Refs

- all 992 fetched remote refs and tags whose names select the v2 product line,
  representing 869 unique tips;
- latest v2 development: `dev/v2/v2.14@daf55ad0e7964658be64c219d473c10c6ace6e67`;
- latest v2 alpha: `alpha/v2/v2.14@42d27e8045e372d9383c613f8dfc32dacffb4f3d`;
- latest v2 release: `release/v2/v2.14@57234bde8f44bac6d96507884e6f9eb2b992547b`;
- reviewed v3 development base:
  `dev/v3/v3.0@7fed4f952790a4474717a98bf6374db8d366faaa`;
- shared merge base:
  `bcdf00393ddec9886fd294a8e5d7830ffaf19f6c`;
- parity implementation branch: `fix/v2-v3-parity-closure`, stacked on the
  exact pinned-self runtime fix at
  `176d2aca157640c53fce8dfa29e18db6a556df64`.

The complete ref audit included authority refs, train refs, work branches,
version-state refs, immutable tags, and other remote v2 coordinates. The v2
development head has 115 commits, including 55 non-merge commits, that
are not ancestors of the reviewed v3 head. Ancestry alone therefore cannot
prove parity. Direct tree comparison reports 311 changed files but no file
present at the latest v2.14 development head and deleted from v3.

## Forward-Port Evidence

The principal convergence point is
`72cf6180776dcef1f6fcec4937effe0126931460`:

> `fix(release): converge v3 publication authority`

Its declared boundary forwards v2.14 release activation, installer sealing,
artifact signing, protected-channel behavior, auditable demos, producer
artifact coordinates, and shared npm alpha authority into v3. Later explicit
closures include:

- `5e0460ca09dada71052e9f84cdea36c7fa0ce29b` — locked checkout;
- `c027ef8f7245eb1a00274952ecde4ec8e6d51927` — stable promotion input surface;
- `05b4c88e515230413ab9f547336cc5c4c89fbeb0` — stable shell input binding;
- `787fd33b78d54fd3bf2ad1507b0d1828765498cb` — governed KFD-4, KFD-5, and
  KFD-7 product gates.

Range and patch review also matched the v2 Paper, release-candidate,
publication, release-propagation, auditable-demo, AWS runner, KFD, and
promotion families to v3 implementations. Release preparation, custody, and
generated version-state commits describe v2 release history and are not product
capability to replay on v3.

## Historical Union Paths

The union of all fetched v2 dev, alpha, and release branch trees contains 35
paths absent from the reviewed v3 tree. They fall into four non-port classes:

1. `.github/workflows/.batch-pull-request.yml` was deliberately retired by
   `c81591de38a80a78d72bca546b1eef610992fcea`; restoring it would reopen an
   excluded orchestration path.
2. `.kungfu/**` and `.xinfa/**` are immutable, content-addressed outputs from
   the historical Buildchain project cut
   `2324a4a607001501d9f72c9217de0b2233769ae7`. Copying them would assert stale
   hashes and qualification facts as current v3 evidence.
3. Root `buildchain.toml` and `buildchain.contract-lock.json` were replaced by
   `.buildchain/buildchain.toml` and `.buildchain/contract-lock.json`; v3 still
   reads the legacy root layout for consumers but owns the namespaced layout.
4. The `kfd-agent-runtime-shaped` fixture and product-specific
   `kfd-agent-runtime-passport` / `kfd7-buildchain-*` modules and tests were
   superseded by `packages/core/kfd-product-gates.js`,
   `tests/kfd-product-gates.test.mjs`, and the public KFD gate documentation.
   The v3 gate is consumer-neutral and fail-closed; restoring the narrower
   profile would create two competing authorities.

These exclusions are semantic replacements or historical evidence, not missing
v3 product work.

## Residual Gaps Closed

The authority-line audit found one v2 patch that had not reached v3:
`1e1b10aa0f094b6e8ce3f7001d1ce57bf7da17ee` shortened the AWS
CodeConnections proof-of-concept name to fit the provider's 32-character limit.
The v3 guide now uses `kungfu-linux-burst-poc`, documents the limit, and has a
regression test that rejects the old overlong value.

The audit also found v3 baseline leakage that ancestry and path comparison
cannot detect:

- the advanced build and web-surface workflows fell back to `v2` when their
  called-workflow identity was unavailable;
- contract-world and contract-lock constructors defaulted to v2;
- Paper scaffold, preflight, and CLI entrypoints defaulted to v2;
- the binary evidence workflow's manual example still selected a v2 tag;
- active manuals and action references still described v2 as the current
  Buildchain line.

Those defaults now resolve to v3. Explicit v2 refs remain valid inputs and test
fixtures where they prove multi-major compatibility; no compatibility parser
or release-history evidence was removed.

The expanded all-ref audit also found one capability that existed only on
`train/v2/v2.3/go-family-release-handoff` at
`c4f3ad6fcc84a131f40e97773975e6b4a81a5dd3`:
Initiative-family release evidence. V3 now restores that optional fail-closed
handoff in its current release-candidate architecture. The exact family
evidence is normalized, included in the candidate hash, carried into
publication authority, and checked by promotion against optional family root,
Initiative id, and Assignment id requirements.

The restored contract remains the Buildchain adapter envelope
`kungfu-buildchain-initiative-family-release-evidence/v1`. It does not copy or
supersede Kungfu Work Control's native immutable Family State v1 projection or
the additive Family State v2 typed envelope.

`contracts/buildchain-v2-residuals-v1.json` remains the machine inventory for
workflow-local v2 tokens. Active runtime fallbacks and the binary example were
removed from that allowlist. Remaining entries are limited to third-party
action versions, fail-closed legacy workflow tombstones, and the explicit
no-publish legacy comparison lane.

## Intentionally Retained v2 References

The following are not v3 baseline leaks:

- the v2 migration inventory and dated engineering retrospective;
- the verified legacy standalone-binary and Homebrew evidence, because v3 does
  not yet publish replacement platform archives;
- downstream product refs such as `site-libkungfu-dev`'s example `dev/v2/v2.7`;
- third-party action majors such as `actions/create-github-app-token@v2`;
- protocol schema identifiers such as the auditable-demo media receipt `/v2`;
- v2 release fixtures that verify generic ref parsing, recovery, and
  compatibility behavior.

Changing those references would rewrite history, change another product's
version, or conflate a schema version with the Buildchain product major.

## Reproduction

The parity evidence can be recomputed with:

```sh
git fetch origin \
  'refs/heads/dev/v2/*:refs/remotes/origin/dev/v2/*' \
  'refs/heads/alpha/v2/*:refs/remotes/origin/alpha/v2/*' \
  'refs/heads/release/v2/*:refs/remotes/origin/release/v2/*' \
  'refs/heads/dev/v3/*:refs/remotes/origin/dev/v3/*'

git merge-base origin/dev/v2/v2.14 origin/dev/v3/v3.0
git rev-list --count origin/dev/v3/v3.0..origin/dev/v2/v2.14
git diff --name-status origin/dev/v2/v2.14 origin/dev/v3/v3.0
```

For the complete audit, enumerate every fetched remote ref and tag whose name
contains a v2 product-line coordinate, deduplicate their tips, and classify
commits not reachable from the v2 authority heads or v3. For the historical
path union, enumerate `git ls-tree -r --name-only` over all fetched v2
dev/alpha/release heads, deduplicate it, and compare it with the v3 development
tree. Verification must then run the workflow residual audit, v3 baseline test,
AWS runner test, workflow validation, site generation check, and the complete
repository check.
