---
status: draft
period: ongoing
theme: web-surface-deployments
doc_type: contract
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  invisible_context_boundary: No credentials, private logs, or unpublished deployment values are included.
  visible_context: Current two-entry consumer contract and retained internal implementation references.
---

# Web-Surface Deployment Contract

This is a reference for the retained internal web deployment engine. It is not
schema-2 consumer onboarding: web is not an additional product type or public
reusable entry in the minimal contract. Current consumers use the shared
normal/recovery pair. The deployment configurations, request envelopes and
provider ports below belong to the internal engine or historical integrations.

Buildchain supports `project.type = "web-surface"` for repositories that publish
sites, docs, product pages, operator consoles, or browser apps. These projects
need auditable deployment semantics, but they are not package release lines and
should not be forced into `dev/alpha/release` version-state automation.

The release object for a web surface is:

```text
source commit + build artifact + deploy target + channel + deployment manifest
```

This keeps the evidence chain clear:

- the source SHA explains what code was built;
- the artifact hash explains exactly what was deployed;
- the channel explains who can see it and whether it is promotable;
- the deploy target and adapter explain where it would be published;
- the deployment manifest records retention, rollback, security, and secret
  reference metadata.

## Configuration

`.buildchain/buildchain.toml` is the source of truth. Web-surface projects must declare
preview, staging, and production channels plus a deploy adapter for each.

```toml
schema = 1

[project]
type = "web-surface"
name = "site-kungfu-tech"
site = "kungfu-tech"

[channels.preview]
url_pattern = "https://{alias}.preview.kungfu.tech"
visibility = "ephemeral"
requires_auth = false
noindex = true

[channels.staging]
url = "https://staging.kungfu.tech"
visibility = "protected"
access_control = "managed-network"
edge_auth = "none"
noindex = true
promotable = true

[channels.production]
url = "https://kungfu.tech"
visibility = "public"
canonical = true
noindex = false

[deploy.preview]
adapter = "aws-s3-cloudfront"
bucket = "kungfu-tech-preview"
cloudfront_distribution = "E-PREVIEW"
artifact_path = "dist"
secret_refs = ["AWS_ROLE_ARN"]
# Optional. Defaults to "buildchain".
# Use "external" when an existing viewer-request CloudFront Function already
# owns preview alias, surface-prefix, and directory-index routing.
directory_index_rewrite = "buildchain"
# Optional. Defaults to HTTP for public channels and S3 object evidence for
# managed-network channels. Use "s3-object" when CI should verify uploaded
# objects and manifests instead of waiting for public edge convergence.
health_strategy = "http"
```

### Multi-Surface Host Mapping

Some site repositories publish more than one first-class web surface from the
same artifact. For example, `site-libkungfu-dev` has a hub plus separate
hostnames for core, Buildchain, and Kung Fu Decisions. These are not just
navigation paths; staging, production preflight, and post-deploy health checks
must verify host-level behavior for each surface.

Declare named surfaces with per-channel URLs:

```toml
[surfaces.hub]
path = "/"
production_url = "https://libkungfu.dev"
staging_url = "https://staging.libkungfu.dev"
preview_url_pattern = "https://{alias}.preview.libkungfu.dev"

[surfaces.core]
path = "/core/"
production_url = "https://core.libkungfu.dev"
staging_url = "https://core.staging.libkungfu.dev"
preview_url_pattern = "https://core-{alias}.preview.libkungfu.dev"

[surfaces.buildchain]
path = "/buildchain/"
production_url = "https://buildchain.libkungfu.dev"
staging_url = "https://buildchain.staging.libkungfu.dev"
preview_url_pattern = "https://buildchain-{alias}.preview.libkungfu.dev"

[surfaces.kfd]
path = "/kfd/"
production_url = "https://kfd.libkungfu.dev"
staging_url = "https://kfd.staging.libkungfu.dev"
preview_url_pattern = "https://kfd-{alias}.preview.libkungfu.dev"
```

Buildchain resolves every `(channel, surface)` pair. A preview alias such as
`pr-12` becomes:

```text
hub:        https://pr-12.preview.libkungfu.dev
core:       https://core-pr-12.preview.libkungfu.dev
buildchain: https://buildchain-pr-12.preview.libkungfu.dev
kfd:        https://kfd-pr-12.preview.libkungfu.dev
```

When `surfaces` is omitted, Buildchain preserves the legacy single-surface
contract by creating an implicit `default` surface from the channel URL. When a
surface is intentionally path-only, declare it explicitly:

```toml
[surfaces.docs]
path = "/docs/"
path_only = true
```

`path_only = true` is an exception, not the default. Without it, every named
surface must declare `preview_url_pattern`, `staging_url`, and
`production_url`. This makes staging/production mismatches fail during
validation instead of becoming invisible deploy drift.

Adapter strategy remains explicit. The default `aws-s3-cloudfront` plan uses the
channel deploy target for every surface, and each binding records its own
bucket, distribution id, object prefix, manifest key, source path, and URL. A
channel can override target details per surface:

```toml
[deploy.staging.surfaces.core]
bucket = "libkungfu-dev-core-staging"
cloudfront_distribution = "E-CORE-STAGING"
origin_path = "/core"
```

Buildchain validates these hard constraints:

- `channels.preview.url_pattern` is required and must contain the alias shape
  used by preview deployments.
- `channels.staging.access_control` must protect staging. Supported modes are
  `managed-network`, `edge-basic-auth`, `oidc`, and `app-auth`.
- `channels.staging.edge_auth` records whether the edge layer owns auth. Use
  `edge_auth = "none"` when staging is protected by managed network controls
  such as WAF/IP allowlists or VPN access.
- `channels.staging.noindex = true` is required.
- `channels.production.url` is required.
- deploy adapters must be declared per channel.
- named surfaces must declare first-class URLs for every channel unless
  `path_only = true` is explicitly set.
- secret material must be declared as reference names, such as
  `secret_refs = ["AWS_ROLE_ARN"]`; inline secret-like deploy keys are rejected.

### Floating Runtime Contract Lock

The internal web component retains runtime-lock validation before build or
provider planning. It is not invoked through a separate consumer web caller.

The caller repository commits `.buildchain/contract-lock.json` after reviewing an
accepted Buildchain runtime SHA and contract digest. The reusable workflow then
resolves the floating runtime to an immutable SHA, checks the lock before the
caller build command, and applies these rules:

- unchanged lock: continue without feedback;
- compatible drift: continue, write the drift summary, and open or update a
  caller-repository issue when permissions allow;
- breaking drift: fail closed before rendering, deployment planning, deploy
  apply, or release publication.

The caller no longer needs to run `packages/core/contracts/commands/buildchain-contract-lock.mjs` inside
its own build command. That check belongs to Buildchain because the actual
contract world is stored in the Buildchain runtime ref being used.

Supported adapter names are:

| Adapter | Initial use |
| --- | --- |
| `aws-s3-cloudfront` | Static site artifact sync plus CDN invalidation plan |
| `aws-elastic-beanstalk` | Future dynamic app environment adapter |
| `aws-ecs-service` | Future dynamic service adapter |

The channel ontology is independent of the adapter. A future dynamic staging
environment still remains `channel = "staging"` with protected/noindex/security
requirements.

## Preview Aliases

Preview uses subdomains, not path prefixes:

```text
https://pr-123.preview.kungfu.tech
https://sha-abcdef123456.preview.kungfu.tech
```

Alias semantics are explicit:

| Alias | Meaning | Mutable | Retention |
| --- | --- | --- | --- |
| `pr-123` | Current preview for a pull request | yes | short-lived |
| `sha-abcdef123456` | Immutable preview for one source SHA | no | longer-lived |

This allows PR comments to stay stable while preserving immutable evidence for a
specific source commit.

## Deployment Manifest

Buildchain emits a manifest with the deployment facts that matter for audit and
rollback:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-web-surface-deployment",
  "site": "libkungfu-dev",
  "channel": "preview",
  "alias": "sha-abcdef123456",
  "url": "https://sha-abcdef123456.preview.libkungfu.dev",
  "generatedAt": "2026-07-01T00:00:00.000Z",
  "publishedAt": "2026-07-01T00:00:00.000Z",
  "reproducible": true,
  "timestampPolicy": "ci-injected",
  "deterministicInputs": [
    "web-surface artifact content",
    "buildchain.toml web-surface channels/deploy/surfaces",
    "sourceSha",
    "artifactHash",
    "deployment channel",
    "deployment alias"
  ],
  "sourceRevision": "...",
  "timestampPolicyDetails": {
    "contract": "kungfu-buildchain-surface-timestamp-policy",
    "timestampFields": ["generatedAt", "publishedAt", "deployedAt"],
    "timestampFieldsParticipateInArtifactDigest": false,
    "artifactDigestScope": "web-surface artifactHash excludes deployment manifest timestamps"
  },
  "sourceSha": "...",
  "artifactHash": "...",
  "deployTarget": "libkungfu-dev-preview",
  "adapter": "aws-s3-cloudfront",
  "deployedAt": "2026-07-01T00:00:00.000Z",
  "retentionClass": "preview-sha-immutable",
  "expiresAt": "2026-09-29T00:00:00.000Z",
  "accessControl": "none",
  "edgeAuth": "none",
  "noindex": true,
  "secretRefs": ["AWS_ROLE_ARN"],
  "surfaceBindings": [
    {
      "surface": "hub",
      "channel": "preview",
      "alias": "sha-abcdef123456",
      "url": "https://sha-abcdef123456.preview.libkungfu.dev",
      "sourcePath": "/",
      "artifactPathPrefix": "",
      "viewerPathPrefix": "/",
      "directoryIndex": "index.html",
      "directoryIndexResolution": true,
      "canonicalUrl": "https://libkungfu.dev",
      "bucket": "libkungfu-dev-preview",
      "distributionId": "E-PREVIEW",
      "originPath": "",
      "objectPrefix": "sha-abcdef123456",
      "manifestKey": ".buildchain/deployments/sha-abcdef123456/hub.json",
      "routing": {
        "contract": "kungfu-buildchain-web-surface-path-prefix-rewrite",
        "viewerPathPrefix": "/",
        "artifactPathPrefix": "",
        "objectPrefix": "sha-abcdef123456",
        "directoryIndex": "index.html",
        "directoryIndexResolution": true
      },
      "smokeUrls": [
        {
          "kind": "root",
          "requestPath": "/",
          "url": "https://sha-abcdef123456.preview.libkungfu.dev/",
          "required": true
        }
      ],
      "noindex": true,
      "accessControl": "none"
    }
  ]
}
```

Dynamic adapters can also fill `runtimeId`, `configFingerprint`,
`healthCheck`, `migrationState`, `rollbackPointer`, and
`rollbackLimitations`. Buildchain records secret reference names only, never
secret values.

The timestamp policy is shared with package site bundles. Public deployment
manifests should expose real workflow generation/publication times while
separately declaring why the deployed artifact remains reproducible. For
web-surface deployment manifests, `artifactHash` is the static site artifact
digest and does not include deployment timestamp fields; the manifest itself
still records those fields for human and agent audit.

## Deploy Plans

Deploy planning is the default behavior. It plans the adapter steps and writes
manifest JSON, but it does not touch AWS, DNS, CloudFront, or deployment
credentials.

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode deploy-plan \
  --cwd fixtures/web-surface-shaped \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --alias sha-aaaaaaaaaaaa
```

For manifest-only output:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode manifest \
  --cwd fixtures/web-surface-shaped \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --alias pr-123 \
  --output .buildchain/web-surface-manifest.json
```

The CLI emits GitHub outputs when `GITHUB_OUTPUT` is present:

- `web-surface-channel`
- `web-surface-alias`
- `web-surface-url`
- `web-surface-urls-json`
- `web-surface-artifact-hash`
- `web-surface-manifest-json`

The reusable workflow resolves that same effective channel before running the
caller build or verify command. Both steps receive
`BUILDCHAIN_WEB_SURFACE_CHANNEL` (`preview`, `staging`, or `production`) and
`BUILDCHAIN_PREVIEW_ALIAS` for previews. Compatibility aliases
`BUILDCHAIN_SURFACE_CHANNEL` and `BUILDCHAIN_WEB_SURFACE_ALIAS` are also
provided. Callers should consume these variables instead of reconstructing the
release-intent state machine from raw GitHub events.
An unapproved manual canary resolves to `staging`; a trusted manual dispatch
with `production-approved=true` resolves to `production` through the same path.

## Explicit Apply

`deploy-apply` and `cleanup-apply` are explicit execution modes for the
`aws-s3-cloudfront` static-site adapter. They still default to `--dry-run true`;
live AWS mutation requires `--dry-run false`.

Deploy apply syncs the artifact, writes the deployment manifest, and invalidates
CloudFront when a distribution id is configured:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode deploy-apply \
  --cwd fixtures/web-surface-shaped \
  --channel staging \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --artifact-path dist \
  --dry-run false \
  --output .buildchain/web-surface-staging-apply.json
```

### Explicit cache classes

The S3/CloudFront adapter can declare cache metadata per deploy channel or
surface override:

```toml
[deploy.production]
adapter = "aws-s3-cloudfront"
cache_control_default = "public,max-age=3600"
cache_control_mutable = "public,max-age=300,must-revalidate"
cache_control_immutable = "public,max-age=31536000,immutable"
```

`cache_control_default` applies to the ordinary artifact sync.
`cache_control_mutable` is then applied to HTML, JSON, XML, generated directory
index aliases, and the deployment manifest. `cache_control_immutable` applies
to append-only publication roots discovered through the archive policy below.
Mutable metadata updates exclude those append-only roots, so HTML or JSON inside
an immutable version archive keeps the immutable class.
The deploy plan, surface binding, apply operations, and deployment manifest all
record the effective values. Existing consumers that omit these fields retain
their prior upload behavior.

Cache metadata complements, rather than replaces, invalidation. Every deploy
still records and creates the exact surface wildcard and deployment-manifest
invalidation paths.

### Immutable publication paths

When a surface artifact contains `manifest.json` with
`archivePolicy.contract = "kungfu-buildchain-publication-archive-policy"`,
Buildchain treats every declared `publications[].versions[].immutablePath` as
an append-only publication boundary. This applies identically to preview,
staging, and production adapters.

The adapter derives the protected archive root from those declared version
paths and applies four ordered safeguards:

1. every local immutable file is checked against an existing S3 object;
2. missing files are uploaded with `aws s3 sync --no-overwrite` and a SHA-256
   checksum;
3. every immutable file is checked again after upload, closing the race between
   the first check and the no-overwrite transfer;
4. mutable site content keeps normal `sync --delete` behavior, but every parent
   or owning surface sync excludes the protected archive root from deletion.

An existing object with a different SHA-256 digest fails apply before mutable
content is changed. Older objects without a stored S3 SHA-256 checksum are read
and byte-hashed for compatibility. Directory-index alias writes are skipped
under protected roots so they cannot overwrite immutable route objects; viewer
request rewriting remains the directory-index authority.

The deploy plan and manifest record `immutablePublication`,
`mutableDeleteExcludes`, and the parent-surface coverage. Apply output records
`immutablePreservation` plus every pre-check, no-overwrite sync, post-check, and
mutable sync operation. Health output adds an `__immutable__` check proving that
the owning and parent surface syncs carried their required delete exclusions.
The runner must provide an AWS CLI version whose `s3 sync` supports
`--no-overwrite`.

### Qualified publication package-pin fast path

A consumer may narrow one deployment to the exact paper version introduced by
a package-pin-only PR. The artifact root `manifest.json` must carry a
consumer-owned qualification envelope:

```json
{
  "publicationFastPath": {
    "contract": "kungfu-buildchain-publication-package-pin-fast-path",
    "mode": "package-pin-only",
    "targetSurface": "papers",
    "qualificationRoot": "sha256:...",
    "immutablePrefixes": [
      "archive/observer-declared-timelines/v0.1.0-alpha.10"
    ],
    "mutableFiles": [
      "archive/index.html",
      "index.html",
      "manifest.json",
      "observer-declared-timelines/index.html",
      "observer-declared-timelines/latest/index.html",
      "registry.json"
    ],
    "invalidationPaths": [
      "/",
      "/archive/",
      "/archive/observer-declared-timelines/v0.1.0-alpha.10*",
      "/observer-declared-timelines/",
      "/observer-declared-timelines/latest/",
      "/manifest.json",
      "/registry.json"
    ]
  }
}
```

Buildchain validates that the target surface exists, every immutable prefix is
declared by that surface's archive manifest, every mutable file exists outside
those prefixes, and the qualification root is exact. A qualified plan:

- selects only `targetSurface`;
- verifies/uploads only the declared immutable prefixes with the normal
  no-overwrite digest safeguards;
- copies only the declared mutable files;
- skips full `sync --delete` and directory-index alias writes;
- invalidates only the declared viewer paths plus the deployment manifest.

Any missing, malformed, or unqualified envelope keeps the normal full-surface
plan. The fast path narrows bytes; it does not weaken channel controls.
`package-published`, `alpha-complete`, `staging-visible`, and
`production-visible` remain separate facts, and a package qualification never
authorizes production by itself.

Publication manifests may retain release history without rematerializing every
historical package into the current site artifact. When at least one version
declares `immutableIndex`, Buildchain treats that field as the materialization
envelope: all declared version prefixes remain protected from deletion, while
only prefixes with `immutableIndex` must exist locally and are eligible for
upload. Manifests without the envelope retain the legacy rule that every
declared prefix must exist.

For multi-surface sites, each surface host is treated as a root-relative view
of that surface's artifact path prefix. For example, a `buildchain` surface with
`path = "/buildchain/"` and preview URL
`https://buildchain-pr-29.preview.libkungfu.dev` syncs the artifact subtree
`dist/buildchain/` to the preview object prefix `pr-29/buildchain`. A viewer
request for `https://buildchain-pr-29.preview.libkungfu.dev/docs/` therefore
resolves against the artifact's `dist/buildchain/docs/index.html`, not
`dist/docs/index.html` and not the hub surface root. The deployment manifest
records this as `routing.contract =
"kungfu-buildchain-web-surface-path-prefix-rewrite"` with
`viewerPathPrefix = "/"`, `artifactPathPrefix = "buildchain"`, and
`directoryIndexResolution = true`.

When a surface uses an S3 object prefix, directory-index routing must be handled
at the viewer-request layer. By default, `directory_index_rewrite =
"buildchain"` makes Buildchain install or update one CloudFront Function per
distribution before uploading payloads. The function rewrites any request path
ending in `/` to the corresponding `index.html`, so
`https://buildchain-pr-29.preview.libkungfu.dev/` resolves to
`pr-29/buildchain/index.html` and
`https://buildchain-pr-29.preview.libkungfu.dev/docs/` resolves to
`pr-29/buildchain/docs/index.html`. This keeps multi-host preview roots
compatible with S3 REST origins, where copying alias objects such as
`pr-29/buildchain` or `pr-29/buildchain/` is not a reliable substitute for an
edge rewrite.

If the distribution already has a viewer-request function that owns preview
alias routing and surface-prefix routing, set `directory_index_rewrite =
"external"` on the deploy channel or surface override. In that mode Buildchain
does not create, update, or attach a generic directory-index function. Instead,
the deployment manifest records `directoryIndexRewrite = "external"` and
`directoryIndexStrategy = "external-viewer-request-function"`, then the normal
health check still verifies every required root and nested surface URL. This is
the correct contract for shared preview distributions such as
`site-libkungfu-dev`, where a generic function cannot replace the existing
prefix router.

Buildchain still writes directory-index alias objects during apply as
compatibility evidence, but root correctness comes from the viewer-request
rewrite contract, not from extensionless S3 keys. If Buildchain-managed mode
finds a distribution with a different viewer-request function, apply fails
closed and records that conflict in the apply result instead of silently serving
403s. If CloudFront rejects `UpdateDistribution` because its optimistic-lock
ETag became stale, Buildchain re-reads the distribution and retries with the
new ETag at most twice. A concurrent update that already attached the intended
function is accepted as converged; a different viewer-request function or any
non-ETag AWS error still fails immediately. The reusable workflow uploads
`buildchain-web-surface-*-diagnostics`
artifacts containing the apply and health JSON so the failing AWS operation or
HTTP check is visible from the consumer run.

It can also execute a previously saved deploy plan. In that mode Buildchain
recomputes the local artifact hash before running AWS commands and fails closed
if the artifact no longer matches the saved plan. Before any adapter operation,
it also checks channel-aware JSON manifests in the artifact: top-level
`canonicalHost` and declared `pages[].host` facts must belong to the plan's
surface hosts. A production plan therefore rejects staging/preview host facts
before AWS apply:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode deploy-apply \
  --cwd fixtures/web-surface-shaped \
  --plan .buildchain/web-surface-staging-plan.json \
  --dry-run false \
  --output .buildchain/web-surface-staging-apply.json
```

Cleanup apply deletes preview content, deletes the preview manifest, and
invalidates CloudFront:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode cleanup-apply \
  --cwd fixtures/web-surface-shaped \
  --event pull-request-closed \
  --pull-number 123 \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --dry-run false \
  --output .buildchain/web-surface-cleanup-apply.json
```

Cleanup apply can also execute a saved cleanup plan:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode cleanup-apply \
  --cwd fixtures/web-surface-shaped \
  --plan .buildchain/web-surface-cleanup-plan.json \
  --dry-run false \
  --output .buildchain/web-surface-cleanup-apply.json
```

Apply output records the channel, alias, source SHA, artifact hash, target
bucket, object prefix, manifest key, all surface URLs, all surface bindings, CDN
invalidation paths, actor/run metadata, immutable preservation evidence, and
every adapter operation with
`executed`, `exitCode`, `stdout`, and `stderr`. If an operation fails,
Buildchain records the failed operation, stops subsequent adapter operations,
and exits non-zero after writing the result JSON. Buildchain records secret
reference names only; the runner must provide the AWS CLI and credentials
outside Buildchain, typically through OIDC and the declared `secret_refs`.

## Production Preflight And Health

Production promotion is not just `deploy-apply --channel production`. Before a
live production apply, the reusable workflow runs:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode production-preflight \
  --cwd fixtures/web-surface-shaped \
  --plan .buildchain/web-surface-production-plan.json \
  --execute true \
  --output .buildchain/web-surface-production-preflight.json
```

The production preflight checks that:

- `channels.production` is canonical and indexable;
- every surface has concrete production bucket and CloudFront targets;
- every production surface URL is HTTPS;
- the production AWS role can inspect the declared bucket and distribution;
- CloudFront aliases cover every surface host, including product hosts such as
  `kfd.libkungfu.dev`;
- DNS resolves for every surface host.

After preview, staging, and production apply, the workflow runs:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode health-check \
  --cwd fixtures/web-surface-shaped \
  --result .buildchain/web-surface-production-apply.json \
  --output .buildchain/web-surface-production-health.json
```

When the apply result includes CloudFront invalidations from the
`aws-s3-cloudfront` adapter, health check waits for those invalidations to reach
`Completed` before fetching public smoke URLs. This avoids reporting stale
CloudFront 403 responses as deployment failures immediately after a successful
S3 sync and invalidation request.

After the invalidation wait, HTTP smoke checks also retry transient 403, 404, and
5xx responses before recording failure. This keeps the public health signal
strict while absorbing short CloudFront edge propagation windows that can remain
visible after the invalidation waiter returns. By default, Buildchain attempts
each HTTP smoke URL 12 times with a 10 second interval. Consumers can override
that window with `BUILDCHAIN_WEB_SURFACE_HEALTH_HTTP_RETRY_ATTEMPTS` and
`BUILDCHAIN_WEB_SURFACE_HEALTH_HTTP_RETRY_INTERVAL_MS` when they need a
site-specific health policy.

The health check fetches every surface root URL and any nested smoke URLs
recorded in each surface binding. Nested smoke URLs are derived from nested HTML
artifact files under the surface path prefix, with directory index resolution
such as `dist/buildchain/docs/index.html` becoming `/docs/` on the buildchain
preview host. If a surface has no nested HTML route, Buildchain records only
the root smoke URL; absence of nested HTML is not a deployment failure. When a
nested route is present, the check fails closed if a deploy reports success but
that child page returns 403 or another unexpected status. Surface root checks
expect the apply result to have installed the directory-index rewrite, so a
multi-host preview root such as `https://buildchain-pr-29.preview.libkungfu.dev/`
must resolve to the surface `index.html`, not the bare prefix directory.
Production additionally fails if a response is unreachable, returns an
unexpected status, or still sends `x-robots-tag: noindex`. The health check also
verifies that each surface binding recorded a deployment manifest pointer. The
production release passport embeds the deploy plan, apply result, production
preflight, and health check so a reviewer or agent can audit why the production
site changed and whether every declared host and every existing nested route was
actually covered.

Public channels can opt into object-level health with
`deploy.<channel>.health_strategy = "s3-object"` when the deployment contract is
already covered by S3 manifest/object writes and public edge convergence is not
the right CI gate. This is useful for preview distributions whose viewer-request
routing is owned by an external CloudFront Function. The channel remains public;
only the CI health evidence changes from HTTP fetches to S3 `head-object`
checks.

Channels declared with `access_control = "managed-network"` use a different
health strategy by default. Buildchain does not require a GitHub-hosted runner
to fetch a URL that is intentionally reachable only from an approved network.
Instead, after a live apply the health check uses the deploy role to run S3
`head-object` checks for each surface manifest and the smoke target object, such
as the surface `index.html` or a nested `docs/index.html`. The check records
`healthStrategy = "s3-object"` and skips the public HTTP fetch. Dry-run and
plan-only checks fall back to deployment evidence: each surface must have a
manifest key, bucket, object prefix, `sync-static-artifact`, and
`write-deployment-manifest` evidence, recorded as
`healthStrategy = "deployment-evidence"`. If the workflow is running on a runner
that is allowed to reach the managed network, set
`BUILDCHAIN_WEB_SURFACE_HEALTH_ALLOWED_RUNNER=true` or pass
`--allowed-managed-network-runner true` to keep the normal HTTP smoke checks.
Set `BUILDCHAIN_WEB_SURFACE_HEALTH_S3_OBJECTS=false` or pass
`--managed-network-s3-object-verification false` only when an external channel
policy owns managed-network object verification.

## Cleanup Plans

Preview cleanup is an auditable cleanup contract. It can run as a dry-run plan,
an apply-mode plan, or the explicit `cleanup-apply` executor with preview-only
credentials:

```bash
node packages/core/web/commands/web-surface.mjs \
  --mode cleanup-plan \
  --cwd fixtures/web-surface-shaped \
  --event pull-request-closed \
  --pull-number 123 \
  --aliases pr-123,sha-abcdef123456
```

The plan and apply result keep mutable PR aliases and immutable SHA aliases
distinct so a caller can expire them with different retention windows. Closed-PR
cleanup can derive `pr-N` from `--pull-number`, records the event, source SHA,
actor, run id, preview bucket/prefix, manifest key, and adapter steps, and is an
auditable no-op when no aliases are requested.

## Internal workflow authority

`.release-web.yml` retains the web engine's job and credential boundaries.
It is an internal component, without a public product-specific alias. Its source,
artifact, runtime, deployment-plan and environment ports must come from admitted
runtime state; consumers do not write a third web workflow or pass these ports
through their generated normal/recovery pair.

Preview, staging and production keep separate provider permissions and evidence.
Production requires exact source/artifact identity and independent admission;
untrusted event inputs cannot grant provider mutation. A successful staging
receipt does not prove production, and an API response does not replace provider
readback. Provider failures preserve the previously valid public authority.

The component's historical release-PR, cleanup and feedback mechanisms remain
internal implementation contracts. Their workflow inputs are not schema-2 TOML
fields or recommended consumer setup. Provider configuration still requires its
own explicit authority and cannot be inferred from product metadata or evidence.

## Site Repository Shape

A site repository can start with:

```toml
schema = 1

[project]
type = "web-surface"
name = "site-kungfu-tech"
site = "kungfu-tech"

[lifecycle.build]
command = "pnpm run build"

[lifecycle.verify]
command = "pnpm run check"
```

Then add the channel, deploy, retention, and security declarations shown above.
The project may use pnpm, npm, yarn, Vite, Astro, Next static export, Sphinx,
MkDocs, CMake-generated docs, or another lifecycle command source. Buildchain
only needs a deterministic artifact path and the manifest facts.

## Signed bootstrap installer publications

A web-surface artifact that contains `installer-publication.json` opts into the
`kungfu.bootstrap-installer-publication/v1` seam. During planning, Buildchain
fails closed unless the manifest binds:

- one signed-channel payload root and exact channel-file digest;
- one source SHA and Release Passport;
- unique platform/architecture entries with manifest, artifact, and archive
  digest roots; and
- byte-identical friendly and immutable `install.sh` / `install.ps1` assets.

The resulting `kungfu-buildchain-installer-publication-evidence/v1` object and
root are welded into the deployment manifest. This does not make Buildchain the
product installer authority: Kungfu generates the installer from its signed
release channel, while the site owns only routes and presentation.

The site artifact should also declare the existing
`kungfu-buildchain-publication-archive-policy` in its root `manifest.json`, with
the versioned installer directory as `immutablePath`. Buildchain then performs
pre-upload object digest checks, `--no-overwrite` upload, post-upload checks, and
excludes the immutable root from mutable deletion.

Local verification:

```sh
node packages/core/publication/commands/installer-publication.mjs \
  --manifest dist/installer-publication.json \
  --artifact-root dist
```

After preview, staging, or production apply, public read-back verifies exact
bytes plus route semantics. Friendly routes require a revalidated cache policy
with `max-age` no greater than 300 seconds; immutable routes require at least
one year and the `immutable` directive:

```sh
node packages/core/publication/commands/installer-publication.mjs \
  --manifest dist/installer-publication.json \
  --public-readback
```

Redirects are not accepted as successful read-back. The evidence retains
content type, cache control, ETag, object version id when exposed, size, digest,
URL, channel root, source SHA, and Release Passport coordinates.

## Boundaries

Buildchain only performs live AWS mutations in explicit apply modes with
`--dry-run false`. Production deploys must still be gated by a human-controlled
workflow, release, or GitHub Environment. DNS changes, staging auth
implementation, CloudFront distribution creation, and credential provisioning
remain explicitly authorized infrastructure operations outside the web-surface
artifact apply contract.
