# promote-buildchain-ref

Internal buildchain action for promoting verified buildchain release-line and
compatibility refs from buildchain release channels:

- `alpha/v1/v1.0` creates or reuses the next exact prerelease tag such as
  `v1.0.1-alpha.0`, writes that version into package version state, points the
  alpha and dev channel branches at the version commit, then promotes
  `v1.0-alpha`;
- `release/v1/v1.0` creates or reuses the next exact release tag such as
  `v1.0.0`, writes that version into package version state, points the release
  channel branch and release tags at the release commit, then prepares a second
  source commit for the next exact prerelease tag such as `v1.0.1-alpha.0` and
  points the alpha/dev channel branches plus `v1.0-alpha` at that prerelease
  commit.

The release branch name defines the minor line. For example,
`release/v1/v1.1` creates `v1.1.N`, promotes `v1.1`, and promotes `v1` only
when the next minor tag such as `v1.2` does not already exist.

The action updates version state in `lerna.json`, root `package.json`, and
workspace package manifests discovered from package manager metadata
(`package.json` workspaces, `lerna.json` packages, or `pnpm-workspace.yaml`).
Package manager detection is adaptive (`pnpm`, `npm`, or `yarn`) and is recorded
in logs; the version commit itself is written through the GitHub Git Data API so
the ref graph is the durable source of truth. Repositories without any supported
version state degrade to ref-only promotion instead of assuming Yarn or Lerna.

In strict buildchain promotion, ref movement is also gated by the old ABV
governance semantics:

- the target channel branch protection details must be readable, must enforce
  protection for administrators, and must require approving PR review plus the
  strict `check` job from the `Verify` workflow;
- alpha promotion must come from a merged same-repository PR
  `dev/vN/vN.M -> alpha/vN/vN.M`;
- release promotion must come from a merged same-repository PR
  `alpha/vN/vN.M -> release/vN/vN.M`;
- release promotion must have an exact alpha tag for the same patch line, and
  the release source tree must match that alpha tag tree, so release does not
  introduce new code after alpha;
- generated release and next-alpha version-state trees can be verified locally
  with a command such as `pnpm run check` before any tags or channel refs move.

The promotion workflow should use `BUILDCHAIN_PROMOTION_TOKEN` for non-dry-run
promotion. The token is the buildchain equivalent of the old ABV runner release
authority: protected branch review and check rules guard human channel merges,
while this action independently rechecks PR lineage, alpha/release tree
equivalence, and generated version-state verification before moving channel
refs and tags.

The tag names intentionally follow the old `action-bump-version` semantics:
exact release tags are `vX.Y.Z`, exact alpha tags are `vX.Y.Z-alpha.N`, floating
release tags are minor/major tags such as `v1.0` and `v1`, and floating alpha
tags are minor-line tags such as `v1.0-alpha`. Bare tags such as `1.0.0` are not
maintained as buildchain release entrypoints.
