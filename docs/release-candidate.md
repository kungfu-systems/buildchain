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
- source head SHA, merge ref SHA, and the Git `HEAD^{tree}` SHA for PR merge
  equivalence after the channel PR lands;
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
passport does not match the repository, channel, source identity, platform
matrix, or build-summary hash. Source identity accepts the exact PR source SHA,
the PR merge ref SHA, or an exact Git tree match with the promoted channel HEAD;
this keeps post-merge channel commits strict without forcing a rebuild. The
Buildchain-owned promotion workflow resolves the matching same-repository
merged channel PR and downloads its PR-stage RC passport automatically before
promotion starts. The consumer wrapper defaults to a PR-stage workflow file
named `build.yml` with display name `Build`, and filters the RC passport and
build summary by the configured `artifact-name` before promotion. It also
downloads payload artifacts from the same PR-stage run, validates the required
payload count, passes downloaded platform manifests into the release passport,
and either forwards an explicit `publish-required-artifacts-json` value or
generates one before calling `promote-buildchain-ref`. Before that call, the
wrapper creates or updates `publish-gate/{alpha,release,major}` to the
promotion channel commit and passes that ref, target SHA, and `locked=true` to
the promote action with `require-publish-source-lock: "true"`. Consumers using
floating `@v2` therefore get publish-side source-lock drift protection without
copying resolver or promote YAML. The default npm path
generates that requirement list from the downloaded `.tgz` payloads themselves:
Buildchain reads `package/package.json` inside each tarball for the real scoped
package name and version, computes npm-style `sha512-...` integrity over the
tarball bytes, marks `publish-package-main` as `role: main`, and marks every
other package as `role: platform`. Consumer workflows therefore stay
declarative and do not need their own artifact download or publish-evidence
generation scripts.

By default, the wrapper forwards GitHub Release publication to the underlying
`promote-buildchain-ref` semver model. Once the release transaction is complete,
the action creates or updates the public GitHub Release, applies
prerelease/latest metadata from the semver tag, and uploads the publish evidence
file together with the generated release passport assets. This keeps
npm/registry publication, Buildchain release passport persistence, and
`release.published` propagation in one declarative reusable workflow. Consumers
that do not publish GitHub Releases can opt out with `github-release: false`.
For anchored/manual package releases, the public GitHub Release tag defaults to
`v<publishedVersion>` while the internal transaction exact tag remains recorded
in the release passport.

Products that publish KFD release trust evidence can keep that path declarative
too. Pass KFD-1 self contract witnesses, KFD-2 public claim files, and KFD-3
pre-build/artifact evidence into the wrapper:

```yaml
jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v2
    with:
      channel: alpha
      artifact-name: libnode
      release-passport-kfd-1-witness-jsons: .buildchain/kfd-1/standard-contract.witness.json
      release-passport-kfd-2-claim-jsons: .buildchain/kfd-2/release-claims.json
      release-passport-kfd-3-prebuild-witness-jsons: .buildchain/kfd-3/collaboration-interface.prebuild.json
      release-passport-kfd-3-artifact-verify-command: kungfu agent verify --json
```

Buildchain forwards those declarations into `promote-buildchain-ref`, verifies
KFD-1 source/artifact contract surfaces, audits KFD-2 public release claims, and
compares KFD-3 declared shipped public surfaces with artifact-exposed public
surfaces. The release passport records the results under `kfd-1`, `kfd-2`, and
the KFD-provided `kfd-3` section.
