# promote-buildchain-ref

Internal buildchain action for promoting verified buildchain release-line and
compatibility tags from buildchain release channels:

- `alpha/v1/v1.0` creates or reuses the next exact prerelease tag such as
  `v1.0.1-alpha.0`, then promotes `v1.0-alpha`;
- `release/v1/v1.0` creates or reuses the next exact release tag such as
  `v1.0.0`, promotes `v1.0`, conditionally promotes `v1`, then prepares the
  next exact prerelease tag such as `v1.0.1-alpha.0` and promotes
  `v1.0-alpha`.

The release branch name defines the minor line. For example,
`release/v1/v1.1` creates `v1.1.N`, promotes `v1.1`, and promotes `v1` only
when the next minor tag such as `v1.2` does not already exist. Rerunning the
same release commit reuses the existing exact tags instead of creating a new
patch or prerelease.

It does not bump package versions, publish packages, or merge release channels.
It only moves buildchain entrypoint tags after the target commit has already
passed Verify on the matching release channel. The tag names intentionally
follow the old `action-bump-version` semantics: exact release tags are
`vX.Y.Z`, exact alpha tags are `vX.Y.Z-alpha.N`, and floating alpha tags are
minor-line tags such as `v1.0-alpha`. Bare tags such as `1.0.0` are not
maintained as buildchain release entrypoints.
