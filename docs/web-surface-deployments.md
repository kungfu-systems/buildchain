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
  "site": "kungfu-tech",
  "channel": "preview",
  "alias": "sha-abcdef123456",
  "url": "https://sha-abcdef123456.preview.kungfu.tech",
  "sourceSha": "...",
  "artifactHash": "...",
  "deployTarget": "kungfu-tech-preview",
  "adapter": "aws-s3-cloudfront",
  "deployedAt": "2026-07-01T00:00:00.000Z",
  "retentionClass": "preview-sha-immutable",
  "expiresAt": "2026-09-29T00:00:00.000Z",
  "accessControl": "none",
  "edgeAuth": "none",
  "noindex": true,
  "secretRefs": ["AWS_ROLE_ARN"]
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
bucket, object prefix, manifest key, CDN invalidation paths, actor/run metadata,
and every adapter operation with `executed`, `exitCode`, `stdout`, and `stderr`.
If an operation fails, Buildchain records the failed operation, stops subsequent
adapter operations, and exits non-zero after writing the result JSON. Buildchain
records secret reference names only; the runner must provide the AWS CLI and
credentials outside Buildchain, typically through OIDC and the declared
`secret_refs`.

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
      buildchain-ref: v2
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
| `workflow_dispatch` with `production-approved = true` | plan `production` and enter the configured GitHub Environment gate |

The workflow deliberately plans and emits manifests by default. Callers that
want live AWS mutation should invoke `deploy-apply` / `cleanup-apply` from a
controlled deploy job with scoped credentials. This keeps production from being
an implicit side effect of merging to `main`.

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
