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
requires_auth = true
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
- `channels.staging.requires_auth = true` is required.
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
  "secretRefs": ["AWS_ROLE_ARN"]
}
```

Dynamic adapters can also fill `runtimeId`, `configFingerprint`,
`healthCheck`, `migrationState`, `rollbackPointer`, and
`rollbackLimitations`. Buildchain records secret reference names only, never
secret values.

## Dry-Run Deploy Plans

The first implementation is deliberately dry-run only. It plans the adapter
steps and writes manifest JSON, but it does not touch AWS, DNS, CloudFront, or
deployment credentials.

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

## Cleanup Plans

Preview cleanup is also a dry-run plan:

```bash
node scripts/web-surface.mjs \
  --mode cleanup-plan \
  --cwd fixtures/web-surface-shaped \
  --aliases pr-123,sha-abcdef123456
```

The plan keeps mutable PR aliases and immutable SHA aliases distinct so a caller
can expire them with different retention windows.

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

Buildchain does not currently perform live AWS mutations for web surfaces.
Production deploy, DNS changes, staging auth implementation, CloudFront
distribution creation, and credential provisioning remain explicitly authorized
operations outside the dry-run contract.

