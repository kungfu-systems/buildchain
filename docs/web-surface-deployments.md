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

`buildchain.toml` is the source of truth. Web-surface projects must declare
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
```

### Multi-Surface Host Mapping

Some site repositories publish more than one first-class web surface from the
same artifact. For example, a developer substrate site may have a hub plus
separate hostnames for core and Buildchain documentation. These are not just
navigation paths; staging and preview should be able to verify host-level
behavior for each surface.

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
```

Buildchain resolves every `(channel, surface)` pair. A preview alias such as
`pr-12` becomes:

```text
hub:        https://pr-12.preview.libkungfu.dev
core:       https://core-pr-12.preview.libkungfu.dev
buildchain: https://buildchain-pr-12.preview.libkungfu.dev
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
      "canonicalUrl": "https://libkungfu.dev",
      "bucket": "libkungfu-dev-preview",
      "distributionId": "E-PREVIEW",
      "originPath": "",
      "objectPrefix": "sha-abcdef123456",
      "manifestKey": ".buildchain/deployments/sha-abcdef123456/hub.json",
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
invalidation paths, actor/run metadata, and every adapter operation with
`executed`, `exitCode`, `stdout`, and `stderr`. If an operation fails,
Buildchain records the failed operation, stops subsequent adapter operations,
and exits non-zero after writing the result JSON. Buildchain records secret
reference names only; the runner must provide the AWS CLI and credentials
outside Buildchain, typically through OIDC and the declared `secret_refs`.

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
| `push` to `main` | validate, build, verify, and plan `staging` from the merged `main` SHA |
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
```

When enabled, Buildchain owns the full release apply state machine:

- PR preview deploys run `deploy-apply --dry-run false` with the preview role
  and update a single idempotent PR comment.
- Closed PR cleanup runs `cleanup-apply --dry-run false` with the preview role
  only.
- Pushes to `main` run staging `deploy-apply --dry-run false` with the staging
  role.
- Release pull requests that match the configured production gate get a
  Buildchain review comment with the staging URL and production target, so the
  operator can verify staging from the PR page and use merge as the approval
  action.
- Production runs when `production-apply` is true and either:
  - a trusted `workflow_dispatch` passes `production-approved=true`; or
  - `production-release-on-main=true` and the `main` push commit is associated
    with exactly one same-repository, merged release pull request matching
    `production-release-label` and `production-release-head-prefix`.
  The production job is then gated by the configured GitHub Environment.

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
      production-release-head-prefix: feature/release-
      production-aws-role-arn: arn:aws:iam::123456789012:role/site-production-github-actions
      production-environment: production
```

The merge button becomes the production approval only for a PR that carries the
release label and comes from the configured source-branch prefix. Ordinary
pull requests merged into `main` keep the staging plan behavior and do not
publish production.

Apply-only inputs are validated before the caller build or verification command
runs. If the current event would run preview, staging, or production apply,
missing role inputs or a production apply without `production-approved=true`
on manual dispatch fail immediately instead of spending the build and plan jobs
first.

Callers must grant `id-token: write` for OIDC role assumption. Preview comments
also need `pull-requests: write`. The AWS roles remain caller-owned and should
be scoped by channel: preview can mutate only preview resources, staging can
mutate only staging resources, and production can mutate only production
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
