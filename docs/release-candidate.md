# Release Candidate Passport

The release-candidate passport is the pre-promotion evidence contract produced
after a reusable build matrix succeeds and before any publish-gate side effects
run. It is different from the release passport:

- `release-candidate-passport.json` proves which source SHA, channel, runtime,
  workflow run, and platform artifacts were verified before promotion.
- `buildchain.release.json` is generated after publish finalization and remains
  the durable audit entrypoint for the published release.

Enable it on the reusable build workflow:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      artifact-name: libnode
      release-candidate: true
      publish-channel: alpha
      publish-source-ref: publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.7
```

When the platform matrix and aggregate summaries complete, Buildchain uploads:

```text
<artifact-name>-release-candidate-<publish-source-sha>
```

The passport contract is `kungfu-buildchain-release-candidate-passport`. It
contains:

- repository and pull request context;
- target channel, target ref, and product version or a non-publish
  `source-<shortSha>` candidate label;
- source head SHA, merge ref SHA, and source tree hash;
- Buildchain runtime ref/SHA and workflow shell ref;
- workflow run id/attempt/url;
- normalized platform matrix and artifact summaries;
- the hash of the aggregate `build-summary.json`.

Promotion workflows that should not rebuild artifacts can enable:

```yaml
- uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
    sha: ${{ needs.build.outputs.publish-source-sha }}
    target-ref: alpha/v22/v22.22
    promote-only-release-candidate: "true"
    release-candidate-passport-path: .buildchain/artifacts/release-candidate-passport.json
    release-candidate-build-summary-path: .buildchain/artifacts/build-summary.json
```

With `promote-only-release-candidate: "true"`, promotion fails before
version-state, publish transaction, tag, or branch side effects when the
passport does not match the repository, channel, source SHA, platform matrix,
or build-summary hash. The diagnostic tells maintainers to run or attach the
verified channel PR build first instead of allowing publish-gate to discover
the mismatch late.

