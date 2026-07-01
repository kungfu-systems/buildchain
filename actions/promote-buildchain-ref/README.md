# promote-buildchain-ref

Internal buildchain action for promoting verified buildchain release-line and
compatibility refs from buildchain release channels:

- `alpha/v2/v2.0` creates or reuses the next exact prerelease tag such as
  `v2.0.1-alpha.0`, writes that version into package version state, points the
  alpha and dev channel branches at the version commit, then promotes
  `v2.0-alpha`;
- `release/v2/v2.0` creates or reuses the next exact release tag such as
  `v2.0.0`, writes that version into package version state, points the release
  channel branch and release tags at the release commit, then prepares a second
  source commit for the next exact prerelease tag such as `v2.0.1-alpha.0` and
  points the alpha/dev channel branches plus `v2.0-alpha` at that prerelease
  commit;
- `publish-gate/major` accepts a reviewed PR from a production release line such
  as `release/v2/v2.0`, writes the next major production version such as
  `v3.0.0`, points `publish-gate/major`, `release/v3/v3.0`, `v3.0`, and `v3`
  at that release commit, then prepares `v3.0.1-alpha.0` for
  `alpha/v3/v3.0`, `dev/v3/v3.0`, and `v3.0-alpha`. The older `major-gate`
  branch name is a compatibility alias only.

The release branch name defines the minor line. For example,
`release/v2/v2.1` creates `v2.1.N`, promotes `v2.1`, and promotes `v2` only
when the next minor tag such as `v2.2` does not already exist.

The action updates version state in `lerna.json`, root `package.json`, and
workspace package manifests discovered from package manager metadata
(`package.json` workspaces, `lerna.json` packages, or `pnpm-workspace.yaml`).
Package manager detection is adaptive (`pnpm`, `npm`, or `yarn`) and is recorded
in logs.

Repositories can also provide `buildchain.toml` to declare version-state files
and `lifecycle.verify`. TOML-configured version files take precedence over
package-manager discovery and can target JSON, TOML, or regex-based files. The
version commit itself is written through the GitHub Git Data API so the ref
graph is the durable source of truth. Repositories without any supported version
state degrade to ref-only promotion only when strict version state is disabled.

Repositories whose package version is anchored to an explicitly selected
upstream release can opt into manual next-anchor behavior:

```toml
[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"
```

In this mode, the action validates the configured version files and anchor
manifest through the repository's verify lifecycle, but it does not rewrite the
package version to match the Buildchain release tag. After a production
release, it sets `next-anchor-required=true` and does not auto-create the next
alpha branch or tag. The repository must create the next upstream anchor line
explicitly, then run the normal channel promotion flow for that line.

When branch protection requires pull requests, generated version-state commits
are also routed through pull requests. The action creates an internal
`buildchain/version-state/...` branch and PR, then stops before moving tags. Once
that PR is reviewed, checked, and merged, the next promotion run verifies that
the merge only changed declared version-state files from the legal source
parent, then moves exact and floating refs.

## Publish Transactions

Promotion can also own external publish side effects. Enable this only from a
trusted channel workflow:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ github.sha }}
    target-ref: release/v2/v2.0
    publish-transaction: "true"
    publish-required-artifacts-json: >-
      [
        {"kind":"npm","name":"@kungfu-systems/buildchain","ref":"2.0.0","digest":"sha256:..."}
      ]
```

When enabled, the action creates or resumes a release transaction keyed by
repository, version, source SHA, and target ref. It runs `lifecycle.publish` from
`buildchain.toml` or the explicit `publish-command` input, then validates publish
evidence before exact tags and floating refs move.

Publish lifecycle environment:

```text
BUILDCHAIN_VERSION
BUILDCHAIN_CHANNEL
BUILDCHAIN_SOURCE_SHA
BUILDCHAIN_TARGET_REF
BUILDCHAIN_RELEASE_STATE
BUILDCHAIN_EVIDENCE_DIR
BUILDCHAIN_RELEASE_SHA
BUILDCHAIN_RELEASE_MATERIAL_SHA
BUILDCHAIN_PUBLISH_TOOLING_SHA
BUILDCHAIN_PUBLISH_EVIDENCE
```

The action outputs `transaction-id`, `transaction-state`,
`transaction-state-path`, `publish-evidence-path`, and `finalization-needed`.
`finalization-needed=true` means publish evidence is valid, but protected branch
or ref finalization needs a later promotion run.

Normal reruns accept already-published artifacts only when evidence matches.
Missing required artifacts can be published on the next run. Conflicting
artifacts put the transaction into `repair_required`; `abandoned` and
`failed_permanently` also fail closed unless `publish-transaction-override` is
set for a controlled repair.

In strict buildchain promotion, ref movement is also gated by the old ABV
governance semantics:

- the target channel branch protection details must be readable, must enforce
  protection for administrators, and must require approving PR review plus the
  strict `check` job from the `Verify` workflow;
- alpha promotion must come from a merged same-repository PR
  `dev/vN/vN.M -> alpha/vN/vN.M`;
- release promotion must come from a merged same-repository PR
  `alpha/vN/vN.M -> release/vN/vN.M`;
- major promotion must come from a merged same-repository PR
  `release/vN/vN.M -> publish-gate/major`;
- release promotion must have an exact alpha tag for the same patch line, and
  the release source tree must match that alpha tag tree, so release does not
  introduce new code after alpha;
- generated release and next-alpha version-state trees can be verified locally
  with either the `verification-command` input or `buildchain.toml`
  `lifecycle.verify` before any tags or channel refs move.

The promotion workflow should use `BUILDCHAIN_PROMOTION_TOKEN` for non-dry-run
promotion. The token is the buildchain equivalent of the old ABV runner release
authority: protected branch review and check rules guard human channel merges,
while this action independently rechecks PR lineage, alpha/release tree
equivalence, and generated version-state verification before moving channel
refs and tags.

The tag names intentionally follow the old ABV release semantics:
exact release tags are `vX.Y.Z`, exact alpha tags are `vX.Y.Z-alpha.N`, floating
release tags are minor/major tags such as `v2.0` and `v2`, and floating alpha
tags are minor-line tags such as `v2.0-alpha`. Bare tags such as `1.0.0` are not
maintained as buildchain release entrypoints.
