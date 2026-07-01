# publish-transaction-shaped

Fixture for the Buildchain publish transaction contract.

It represents a release unit with three required artifact families:

- npm package metadata;
- OCI image digest;
- binary archive digest.

The fixture does not publish to external services. `lifecycle.publish` writes
generic Buildchain evidence to `BUILDCHAIN_PUBLISH_EVIDENCE`, which is enough for
tests and for consumers to understand the expected shape.

```bash
BUILDCHAIN_VERSION=1.0.0 \
BUILDCHAIN_CHANNEL=release \
BUILDCHAIN_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
BUILDCHAIN_RELEASE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
BUILDCHAIN_RELEASE_MATERIAL_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
BUILDCHAIN_PUBLISH_TOOLING_SHA=cccccccccccccccccccccccccccccccccccccccc \
BUILDCHAIN_TARGET_REF=release/v1/v1.0 \
BUILDCHAIN_EVIDENCE_DIR=.buildchain/release-evidence/v1.0.0 \
BUILDCHAIN_PUBLISH_EVIDENCE=.buildchain/release-evidence/v1.0.0/evidence.json \
node scripts/publish.mjs
```
