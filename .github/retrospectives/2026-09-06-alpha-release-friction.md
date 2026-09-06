---
status: draft
period: 2026-09-06
sensitivity: public
theme: buildchain-alpha-release-friction
doc_type: engineering-retrospective
source_level: github-actions-and-release-assets
confidence: high
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-06
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-06
  invisible_context_boundary: This record qualifies Buildchain itself; downstream repositories and native macOS or Windows execution were not qualified.
---

# Alpha.38 release observation

Buildchain `4.0.2-alpha.38` was released through protected
[PR #3522](https://github.com/kungfu-systems/buildchain/pull/3522).
Publication, binary distribution, binary asset publication, and the next
`4.0.2-alpha.39` development PR all completed automatically on their first
workflow attempts. No publication rerun, recovery dispatch, npm login, manual
version edit, or manual next-development review/merge was needed.

The promoted development head was
`54a23658004304d6eec29107ba6f843fa7dc0867`; the release source and exact tag resolve
to `5cbaa22bfec20ab1970bc4a7914040d78c52ff76`. Promotion executed the public
reusable workflow from the previously published alpha.37 runtime,
`f5fa1a4a3e8d83eccee79c077e5f48417760c9df`.

## Observed sequence

Times are UTC on 2026-09-06, from GitHub PR and workflow timestamps. They are
observations from one release, not isolated performance benchmarks.

| Event                              | Time or interval  | Evidence                                                                              |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| Release PR Verify                  | 03:32:31–03:37:41 | [34009250310](https://github.com/kungfu-systems/buildchain/actions/runs/34009250310)  |
| Release PR merged                  | 03:37:46          | [PR #3522](https://github.com/kungfu-systems/buildchain/pull/3522)                    |
| Alpha push Verify                  | 03:37:50–03:42:59 | [34009472586](https://github.com/kungfu-systems/buildchain/actions/runs/34009472586)  |
| Automatic promotion                | 03:43:01–03:49:27 | [34009692567](https://github.com/kungfu-systems/buildchain/actions/runs/34009692567)  |
| GitHub prerelease published        | 03:44:21          | [alpha.38](https://github.com/kungfu-systems/buildchain/releases/tag/v4.0.2-alpha.38) |
| Three-platform binary distribution | 03:44:19–03:46:18 | [34009744647](https://github.com/kungfu-systems/buildchain/actions/runs/34009744647)  |
| Binary asset publication           | 03:46:15–03:47:52 | [34009825068](https://github.com/kungfu-systems/buildchain/actions/runs/34009825068)  |
| Next-development Verify            | 03:44:43–03:46:05 | [34009759698](https://github.com/kungfu-systems/buildchain/actions/runs/34009759698)  |
| Automatic independent review       | 03:46:07–03:46:52 | [34009819440](https://github.com/kungfu-systems/buildchain/actions/runs/34009819440)  |
| Next-development queue Verify      | 03:47:03–03:48:36 | [34009857566](https://github.com/kungfu-systems/buildchain/actions/runs/34009857566)  |
| Next-development merged            | 03:49:07          | [PR #3523](https://github.com/kungfu-systems/buildchain/pull/3523)                    |

The protected release merge to the final promotion result took 11m41s. The
next-development merge is `c0edeadbf15c2a5a4d5482fc9a38b48c41ba6874`.

## Remaining friction

- **Release entry still needs operator orchestration.** The operator inspects
  the source and compatibility changes, creates the development-to-alpha PR,
  obtains exact-head independent approval, and enables protected auto-merge.
  This observation did not use a single release-start command. The automated
  tail starts after successful alpha push Verify.
- **Verification dominates latency.** Both the release PR and alpha push
  `check` jobs took 4m42s and each ran the full verification lifecycle. The
  generated next-development `check` took 52s. Reusing source evidence could
  reduce the release latency only if the exact merge/source identity remains
  proved; required checks were retained throughout this run.
- **Independent artifact readback remains operator work.** The hosted
  publication and binary workflows verify their own boundaries. This audit
  additionally retrieved public artifacts, checked their bytes and receipt
  lineage, and inspected npm and Git refs. Slow local downloads and one GitHub
  TLS timeout delayed that audit; they did not require a publication retry.

## Verification boundary

The public publication settlement verifies as `complete`, with ReleaseReceipt
root `sha256:2f2400fe754851415f2e3249b48f4c00e0d3fe02ddaf69c2c173c0a194f3de0b`.
The public settlement documents match the original APPLY artifact. The npm
package matches the sealed publication payload byte for byte, verifies against
registry SHA-1 and SHA-512 integrity, and contains the exact source WASM bytes.
The npm `alpha` tag is `4.0.2-alpha.38`; Git refs `v4.0.2-alpha.38`, `v4-alpha`,
`v4.0-alpha`, and `alpha/v4/v4.0` resolve to the release source above.

Actual macOS ARM64, Windows x64, and Linux x64 archive bytes match GitHub asset
digests, `checksums.txt`, and the binary Passport. The Linux executable reports
`v4.0.2-alpha.38`. Native macOS and Windows execution was not repeated by this
audit. Stable refs and npm `latest` remained unchanged during observation.

## Compatibility impact

This alpha includes the workflow path retirement from
[PR #3521](https://github.com/kungfu-systems/buildchain/pull/3521):
`v4-adopter-delivery.yml`, `v4-stage-capsule-canary.yml`, and
`v4-tail-reseal.yml` are removed. Their canonical replacements are
`public-build-adopter-qualification.yml`,
`public-build-stage-capsule-canary.yml`, and `public-ops-tail-reseal.yml`.
See the [workflow path migration guide](../../docs/workflow-path-migration.md).
This release audit covers Buildchain itself; it does not certify or migrate
callers of the removed paths. Stable publication was outside scope.
