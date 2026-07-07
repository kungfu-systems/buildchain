# Release Propagation

Release propagation lets a finalized upstream release open a downstream update
PR using the upstream release passport as the audit source. It is for product
chains such as:

```text
kfd -> site-libkungfu-dev
A -> B -> C
```

The downstream repository receives an exact lock, not a floating dist-tag. A
site or app can then consume the upstream package, site bundle, or release
passport as its single source of truth without hand-copying release facts.

## Contract

The propagation graph is declarative JSON:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-release-propagation-graph",
  "nodes": [
    {
      "id": "kfd",
      "repository": "kungfu-systems/kfd",
      "package": "@kungfu-tech/kfd"
    },
    {
      "id": "site-libkungfu-dev",
      "repository": "kungfu-systems/site-libkungfu-dev",
      "lockPath": "buildchain.upstreams/kfd.release.json",
      "baseRef": "dev/v2/v2.7"
    }
  ],
  "edges": [
    {
      "id": "kfd-to-site",
      "from": "kfd",
      "to": "site-libkungfu-dev",
      "channelPolicy": "preserve"
    }
  ]
}
```

`channelPolicy: "preserve"` is the default and maps:

```text
alpha   -> alpha
release -> release
```

Cross-channel mapping is allowed only when an edge declares
`channelPolicy: "explicit"` and a `channelMap`. Buildchain rejects cycles so a
chain can fan out or continue as `A -> B -> C`, but cannot loop back into an
already visited release line.

## Upstream Release Envelope

The upstream release envelope is the post-finalization fact set:

```json
{
  "repository": "kungfu-systems/kfd",
  "channel": "alpha",
  "tag": "v1.4.0-alpha.3",
  "sourceSha": "1111111111111111111111111111111111111111",
  "package": {
    "name": "@kungfu-tech/kfd",
    "version": "1.4.0-alpha.3",
    "integrity": "sha512-..."
  },
  "releasePassport": {
    "url": "https://github.com/kungfu-systems/kfd/releases/download/v1.4.0-alpha.3/buildchain.release.json",
    "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "siteBundle": {
    "manifestSha256": "3333333333333333333333333333333333333333333333333333333333333333"
  }
}
```

The package version and integrity must be exact. Downstream build logic should
install that version directly, not resolve `alpha` or `latest` again.

## CLI

Generate a propagation plan:

```bash
buildchain release-propagation plan \
  --graph buildchain.release-propagation.json \
  --upstream-release .buildchain/upstream-release.json \
  --output .buildchain/release-propagation-plan.json \
  --json
```

Write the downstream lock:

```bash
buildchain release-propagation write-lock \
  --plan .buildchain/release-propagation-plan.json \
  --target site-libkungfu-dev \
  --cwd downstream-checkout \
  --json
```

The written lock has contract
`kungfu-buildchain-release-propagation-lock` and records:

- upstream repository, channel, exact tag, source SHA;
- npm package name, exact version, and sha512 integrity;
- release passport URL and SHA-256;
- optional site bundle manifest SHA-256;
- downstream repository, channel, base ref, lock path;
- edge id and channel policy.

## Reusable Workflow

Upstream repositories can call
`.github/workflows/release-propagation.yml@v2` after release finalization:

```yaml
jobs:
  propagate-site:
    uses: kungfu-systems/buildchain/.github/workflows/release-propagation.yml@v2
    with:
      buildchain-ref: v2
      graph-json: ${{ needs.release.outputs.propagation-graph-json }}
      upstream-release-json: ${{ needs.release.outputs.upstream-release-json }}
      downstream-target: site-libkungfu-dev
      downstream-repository: kungfu-systems/site-libkungfu-dev
      downstream-base-ref: dev/v2/v2.7
      dry-run: false
    secrets:
      propagation-token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
```

The workflow checks out the Buildchain runtime selected by
`buildchain-repository` and `buildchain-ref` into `.buildchain/runtime`, invokes
that runtime for the propagation plan and lock write, then checks out the
downstream repository, writes the exact lock, and opens or updates a PR. It does
not publish the downstream release directly. The downstream repository keeps its
normal Buildchain governance: the PR updates source-of-truth facts, then
downstream alpha or release publication runs through its own protected channel.
For unreleased runtime validation, keep the caller's reusable workflow reference
on `@v2` and pass a temporary train ref through `buildchain-ref`.

## kfd to site-libkungfu-dev

For `kfd -> site-libkungfu-dev`, the graph should preserve channels:

- a `kfd` alpha release produces a downstream alpha lock and downstream alpha
  publication consumes the exact `@kungfu-tech/kfd@...-alpha.N` package;
- a `kfd` stable release produces a downstream release lock and downstream
  stable publication consumes the exact stable package.

This keeps the site synchronized to the package truth without allowing the site
to drift onto a floating npm dist-tag.
