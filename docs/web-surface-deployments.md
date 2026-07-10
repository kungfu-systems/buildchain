# Web-Surface Deployment Contract

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

Web-surface repositories can consume the stable Buildchain workflow shell with a
floating ref, such as:

```yaml
jobs:
  web:
    uses: kungfu-systems/buildchain/.github/workflows/.web-surface.yml@v2
    with:
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      buildchain-contract-compatibility-policy: major-compatible
      buildchain-contract-drift-issue-mode: compatible-and-breaking
      build-command: pnpm build
      artifact-path: dist
```

The caller repository commits `.buildchain/contract-lock.json` after reviewing an
accepted Buildchain runtime SHA and contract digest. The reusable workflow then
resolves the floating runtime to an immutable SHA, checks the lock before the
caller build command, and applies these rules:

- unchanged lock: continue without feedback;
- compatible drift: continue, write the drift summary, and open or update a
  caller-repository issue when permissions allow;
- breaking drift: fail closed before rendering, deployment planning, deploy
  apply, or release publication.

The caller no longer needs to run `scripts/buildchain-contract-lock.mjs` inside
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
node scripts/web-surface.mjs \
  --mode deploy-plan \
  --cwd fixtures/web-surface-shaped \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --alias sha-aaaaaaaaaaaa
```

For manifest-only output:

```bash
node scripts/web-surface.mjs \
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

## Explicit Apply

`deploy-apply` and `cleanup-apply` are explicit execution modes for the
`aws-s3-cloudfront` static-site adapter. They still default to `--dry-run true`;
live AWS mutation requires `--dry-run false`.

Deploy apply syncs the artifact, writes the deployment manifest, and invalidates
CloudFront when a distribution id is configured:

```bash
node scripts/web-surface.mjs \
  --mode deploy-apply \
  --cwd fixtures/web-surface-shaped \
  --channel staging \
  --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --artifact-path dist \
  --dry-run false \
  --output .buildchain/web-surface-staging-apply.json
```

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
403s. The reusable workflow uploads `buildchain-web-surface-*-diagnostics`
artifacts containing the apply and health JSON so the failing AWS operation or
HTTP check is visible from the consumer run.

It can also execute a previously saved deploy plan. In that mode Buildchain
recomputes the local artifact hash before running AWS commands and fails closed
if the artifact no longer matches the saved plan:

```bash
node scripts/web-surface.mjs \
  --mode deploy-apply \
  --cwd fixtures/web-surface-shaped \
  --plan .buildchain/web-surface-staging-plan.json \
  --dry-run false \
  --output .buildchain/web-surface-staging-apply.json
```

Cleanup apply deletes preview content, deletes the preview manifest, and
invalidates CloudFront:

```bash
node scripts/web-surface.mjs \
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
node scripts/web-surface.mjs \
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
node scripts/web-surface.mjs \
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
node scripts/web-surface.mjs \
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
node scripts/web-surface.mjs \
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

## Reusable Workflow Shape

Buildchain ships `.github/workflows/.web-surface.yml` for repositories that want
the standard PR review and promotion flow without copying bespoke glue:

```yaml
jobs:
  web-surface:
    uses: kungfu-systems/buildchain/.github/workflows/.web-surface.yml@v2
    with:
      build-command: npm run build
      verify-command: npm run check
      artifact-path: dist
```

The reusable workflow maps GitHub events to Buildchain web-surface semantics:

| Event | Buildchain behavior |
| --- | --- |
| `pull_request` opened / synchronized / reopened | validate, build, verify, and plan `preview` for `pr-N` |
| `pull_request` closed | plan apply-mode cleanup for the `pr-N` preview alias and manifest |
| `push` to `main` | validate, build, verify, plan and apply `staging` from the merged `main` SHA, then optionally open a production release PR |
| `push` to `main` from a matching release PR merge | validate the associated release PR, plan `production`, and enter the configured GitHub Environment gate |
| `workflow_dispatch` with `production-approved = true` | plan `production` and enter the configured GitHub Environment gate |

The optional `buildchain-ref` input is empty by default. Empty keeps the
web-surface run on the stable Buildchain runtime selected by the reusable
workflow ref, normally `@v2`. A trusted maintainer can expose a
`workflow_dispatch` input and pass it through for one-off train validation.
See [`runtime-train-validation.md`](runtime-train-validation.md) for the shared
train protocol and notification template:

```yaml
on:
  workflow_dispatch:
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref for trusted manual validation"
        required: false
        default: ""

jobs:
  web-surface:
    uses: kungfu-systems/buildchain/.github/workflows/.web-surface.yml@v2
    with:
      buildchain-ref: ${{ inputs.buildchain-ref || '' }}
      build-command: pnpm run build
      verify-command: pnpm run check
      artifact-path: dist
```

Only trusted `workflow_dispatch` runs by repository actors with write,
maintain, or admin permission may use a non-empty runtime override. Train refs
such as `train/v2/v2.3/site-source-of-truth` are temporary validation refs, not
stable production dependencies or pending merge targets. They may remain for a
retention window after release as a fast-use and rollback channel, with old
trains handled by periodic Buildchain cleanup. The web-surface deployment
manifest records the resolved runtime SHA as `runtimeId` and the stable
rollback ref as `rollbackPointer`.

The workflow deliberately plans and emits manifests by default. Live mutation is
opt-in per channel:

```yaml
permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  web-surface:
    uses: kungfu-systems/buildchain/.github/workflows/.web-surface.yml@v2
    with:
      build-command: pnpm run build
      verify-command: pnpm run check
      artifact-path: dist
      preview-apply: true
      preview-cleanup-apply: true
      preview-aws-role-arn: arn:aws:iam::123456789012:role/site-preview-github-actions
      staging-apply: true
      staging-aws-role-arn: arn:aws:iam::123456789012:role/site-staging-github-actions
      production-apply: false
      production-release-on-main: false
      production-aws-role-arn: arn:aws:iam::123456789012:role/site-production-github-actions
      production-environment: production
      release-feedback-actor-privacy: public
```

When enabled, Buildchain owns the full release apply state machine:

- PR preview deploys run `deploy-apply --dry-run false` with the preview role
  and update a single idempotent PR comment.
- Closed PR cleanup runs `cleanup-apply --dry-run false` with the preview role
  only.
- Pushes to `main` run staging `deploy-apply --dry-run false` with the staging
  role, then write a staging release feedback passport artifact and comment the
  associated merged PR with the staging URL, source SHA, artifact identity, run
  URL, and failure context when apply did not complete.
- When `production-release-on-main=true`, successful staging applies open or
  update a Buildchain-owned release PR from
  `release/<channel>-<short-sha>` to `main`, unless the current push already
  came from a matching release PR merge. The release PR contains one empty
  release-intent commit, carries `production-release-label`, and includes the
  staging URLs, source SHA, artifact hash, and staging release-passport artifact
  link in the PR body.
- Production release PR handoff is permission-aware. Staging apply and staging
  health remain successful even when the repository or organization has
  GitHub Actions workflow permissions set to read-only. In that case Buildchain
  records `release-pr-status=permission-denied`, uploads the release PR handoff
  summary/body plus staging release passport artifacts, and writes an exact
  manual `gh pr create` command to the step summary. Set
  `fail-on-release-pr-error=true` only when PR creation failure should fail the
  whole workflow.
- Release pull requests that match the configured production gate get a
  Buildchain review comment with the staging URL and production target, so the
  operator can verify staging from the PR page and use merge as the approval
  action. Consumers do not need to hand-write `gh pr create` or production
  release-intent glue.
- Production runs when `production-apply` is true and either:
  - a trusted `workflow_dispatch` passes `production-approved=true`; or
  - `production-release-on-main=true` and the `main` push commit is associated
    with exactly one same-repository, merged release pull request matching
    `production-release-label` and `production-release-head-prefix`.
  The production job is then gated by the configured GitHub Environment.
- Production apply writes a production release feedback passport artifact and
  comments the release PR with the production URL, source SHA, artifact
  identity, run URL, rollback pointer, and failure context when apply did not
  complete.

The feedback passport records the release responsibility chain:

- human decision actor;
- trigger actor;
- runner/execution actor;
- OIDC/deploy identity reference;
- decision type and time;
- source event, PR number, merge commit, and required gate label/head-prefix.

`release-feedback-actor-privacy` controls actor values in the passport and
comments. `public` records GitHub actor names, `redacted` records only the actor
role, and `private-ref` records a stable private reference hash without exposing
the actor name.

For release-PR publishing, callers opt in explicitly:

```yaml
jobs:
  web-surface:
    uses: kungfu-systems/buildchain/.github/workflows/.web-surface.yml@v2
    with:
      build-command: npm run build
      verify-command: npm run check
      artifact-path: dist
      production-apply: ${{ github.event_name == 'push' && github.ref_name == 'main' }}
      production-release-on-main: true
      production-release-label: buildchain-release
      production-release-head-prefix: release/
      production-release-branch-channel: production
      production-release-pr-mode: auto
      production-aws-role-arn: arn:aws:iam::123456789012:role/site-production-github-actions
      production-environment: production
```

`production-release-pr-mode` controls the post-staging handoff:

| Mode | Behavior |
| --- | --- |
| `auto` | Generate release PR facts, create/update the empty release-intent branch and PR, and label it when token permissions allow. This is the default. |
| `summary-only` | Generate and upload release PR facts, body, passport evidence, and manual command, but do not call the GitHub PR API. |
| `disabled` | Record a disabled handoff and skip release PR API calls. |

Automatic release PR creation normally uses the workflow `github.token`.
Consumers that cannot enable "GitHub Actions can create and approve pull
requests" globally should prefer the first-class GitHub App path. Pass the App
client id as an input and the private key as a reusable workflow secret; Buildchain
creates an installation token inside the release PR job and uses it only for the
release-intent branch, PR, and label operations:

```yaml
with:
  production-release-app-client-id: ${{ vars.KUNGFU_RELEASE_APP_CLIENT_ID }}
secrets:
  production-release-app-private-key: ${{ secrets.KUNGFU_RELEASE_APP_PRIVATE_KEY }}
```

When either side of the App configuration is missing, Buildchain does not hide
that behind the fallback `github.token`. The handoff JSON and job summary report
`status: "app-token-unavailable"` with an `appTokenStatus` such as
`missing-client-id`, `missing-private-key`, or `create-failed`, and still include
the manual PR creation command. If the repository intentionally uses another
narrow token, pass it through `production-release-pr-token`.

`production-release-app-id` remains accepted as a deprecated alias for the input
name, but the value should be the GitHub App client id. GitHub App numeric App
IDs and client IDs are distinct, and Buildchain passes the value to
`actions/create-github-app-token` through its non-deprecated `client-id` input so
new runs do not emit the deprecated `app-id` warning.

If a repository already generates its own narrow token or PAT, it can still pass
that through `production-release-pr-token`:

```yaml
with:
  production-release-pr-token: ${{ secrets.BUILDCHAIN_RELEASE_PR_TOKEN }}
```

Token priority is: generated GitHub App installation token,
`production-release-pr-token`, then `github.token`.

The merge button becomes the production approval only for a PR that carries the
release label and comes from the configured source-branch prefix. Ordinary pull
requests merged into `main` deploy staging and open a release-intent PR; merging
that release PR triggers production. A release PR merge push does not open
another release PR.

Apply-only inputs are validated before the caller build or verification command
runs. If the current event would run preview, staging, or production apply,
missing role inputs or a production apply without `production-approved=true`
on manual dispatch fail immediately instead of spending the build and plan jobs
first.

Callers must grant `id-token: write` for OIDC role assumption. Preview comments
need `pull-requests: write`. Automatic release PR creation also needs
`contents: write`, `pull-requests: write`, and `issues: write` so Buildchain can
create the release branch, write the empty release-intent commit, open or update
the PR, and apply the release label. If these permissions are unavailable,
Buildchain degrades the release handoff instead of marking a successful staging
deployment as failed, unless `fail-on-release-pr-error=true`. The AWS roles remain caller-owned and
should be scoped by channel: preview can mutate only preview resources, staging
can mutate only staging resources, and production can mutate only production
resources.

Apply mode fails closed when the deploy config still contains placeholder AWS
targets such as `pending-preview-distribution`. Planning can use placeholders
for dry-run-only design work, but live apply requires concrete bucket and
CloudFront distribution identifiers.

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

## Boundaries

Buildchain only performs live AWS mutations in explicit apply modes with
`--dry-run false`. Production deploys must still be gated by a human-controlled
workflow, release, or GitHub Environment. DNS changes, staging auth
implementation, CloudFront distribution creation, and credential provisioning
remain explicitly authorized infrastructure operations outside the web-surface
artifact apply contract.
