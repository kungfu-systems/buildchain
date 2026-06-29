# promote-buildchain-ref

Internal buildchain action for promoting verified buildchain release-line and
compatibility tags from buildchain release channels:

- `alpha/v1/v1.0` promotes `v1-alpha`;
- `release/v1/v1.0` creates or reuses the next `1.0.N` release tag, then
  promotes `v1` and `v1.0` to the same commit.

The release branch name defines the minor line. For example,
`release/v1/v1.1` creates `1.1.N`, then promotes `v1` and `v1.1`. Rerunning the
same release commit reuses the existing `N` tag instead of creating a new patch.

It does not bump package versions, publish packages, or merge release channels.
It only moves buildchain entrypoint tags after the target commit has already
passed Verify on the matching release channel.
