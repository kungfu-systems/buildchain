# Consumer Issue Reporting

Buildchain ships a first-class issue reporting surface for consumer workflows.
It lets a repository open or update a Buildchain-owned GitHub issue when a
Buildchain reusable workflow, action, or toolkit API produces a failure that
needs Buildchain maintainers.

## Trust model

The consumer workflow must provide a token with issue-write access to the
target repository. A repository's default `GITHUB_TOKEN` only writes to its own
repository, so cross-repository reports should use a GitHub App installation
token scoped to:

- the `kungfu-systems/buildchain` repository;
- Issues: read and write;
- no content write permission unless another workflow step needs it.

The recommended pattern is:

```yaml
- uses: actions/create-github-app-token@v2
  id: buildchain-issue-token
  with:
    app-id: ${{ secrets.BUILDCHAIN_ISSUE_APP_ID }}
    private-key: ${{ secrets.BUILDCHAIN_ISSUE_APP_PRIVATE_KEY }}
    owner: kungfu-systems
    repositories: buildchain

- uses: kungfu-systems/buildchain/actions/report-buildchain-issue@v2
  if: failure()
  with:
    token: ${{ steps.buildchain-issue-token.outputs.token }}
    summary: "Buildchain reusable build failed before artifact finalization"
    failure-code: reusable-build-failed
    diagnostics-path: .buildchain/artifacts/diagnostics.json
    buildchain-ref: ${{ inputs.buildchain-ref || 'v2' }}
```

## Behavior

`report-buildchain-issue` builds an issue body with consumer repository,
workflow, ref, SHA, Buildchain ref/version, diagnostics links, and optional
details. It computes a stable fingerprint and embeds a hidden marker:

```text
buildchain-consumer-issue:fingerprint=<sha256-prefix>
```

When an open issue with the same marker exists, the action comments on it with
the new run evidence. Otherwise it creates a new issue. Consumers may pass an
explicit `fingerprint` when they need a different dedupe boundary.

The action is fail-soft by default. It retries GitHub API 429/5xx responses and
connection failures, redacts common secret/token/private-key patterns, truncates
large bodies, and retries issue creation without labels if the target
repository does not have the configured labels yet.

Set `fail-on-error: "true"` only when the reporting step is part of a release
gate and missing Buildchain feedback should stop the workflow.

## JavaScript API

Consumer scripts can import the same implementation:

```js
import {
  buildConsumerIssueReport,
  reportBuildchainIssue,
} from "@kungfu-tech/buildchain/issue-reporting";

const result = await reportBuildchainIssue({
  token: process.env.BUILDCHAIN_ISSUE_TOKEN,
  summary: "Native artifact manifest is incomplete",
  failureCode: "native-manifest-incomplete",
  buildchainRef: "v2",
  diagnosticsPath: ".buildchain/artifacts/diagnostics.json",
});
```

Use `buildConsumerIssueReport` for dry-run validation, previewing redaction, or
unit tests without calling GitHub.
