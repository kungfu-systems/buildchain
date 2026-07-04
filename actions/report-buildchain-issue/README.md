# report-buildchain-issue

Create or update a Buildchain repository issue from a consumer workflow or from
Buildchain's own workflow-friction feedback loop.

This action is intended for consumer repositories that need to report
Buildchain-owned failures with enough evidence for maintainers to act. It
requires a token that can write issues on the target Buildchain repository.
For cross-repository consumers, generate that token with a GitHub App
installation token or another scoped credential owned by the consumer
organization.

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
    summary: "Reusable build failed before artifact finalization"
    failure-code: reusable-build-failed
    buildchain-ref: ${{ inputs.buildchain-ref || 'v2' }}
    diagnostics-path: .buildchain/artifacts/diagnostics.json
```

The action computes a stable fingerprint from the consumer repository,
workflow, job, failure code, and Buildchain ref. When an open issue already
exists for that fingerprint, it comments with the new run instead of opening a
duplicate issue.

By default issue reporting is fail-soft:

- `fail-on-error: "false"` prevents a reporting outage from hiding the original
  build failure.
- transient GitHub API 429/5xx errors and connection failures are retried.
- if a configured label is missing, issue creation is retried without labels.
- if issue creation/commenting is still unavailable, the action writes the full
  copyable issue title, fingerprint, and body into the workflow summary.
- common token, private-key, password, and authorization values are redacted
  before submission.

Use `dry-run: "true"` to verify the computed fingerprint and body shape without
calling GitHub.

For Buildchain-owned workflow friction, use `report-kind: workflow-friction`.
This uses a separate marker and default labels so duplicate PRs, duplicate
builds, transient API failures, stale release-state, or missing RC evidence can
be grouped without mixing with consumer failure reports:

```yaml
permissions:
  issues: write

steps:
  - uses: kungfu-systems/buildchain/actions/report-buildchain-issue@v2
    if: failure()
    with:
      token: ${{ github.token }}
      report-kind: workflow-friction
      target-repository: ${{ github.repository }}
      repository: ${{ github.repository }}
      workflow: ${{ github.workflow }}
      run-id: ${{ github.run_id }}
      run-attempt: ${{ github.run_attempt }}
      channel: alpha/v2/v2.4
      source-sha: ${{ github.sha }}
      friction-class: duplicate-build
      related-runs-json: ${{ steps.classify.outputs.related-runs-json }}
      heavy-builds-json: ${{ steps.classify.outputs.heavy-builds-json }}
      comment-cooldown-hours: "24"
```

`comment-cooldown-hours` is optional. When it is greater than zero, Buildchain
still deduplicates by fingerprint but skips adding another comment if the
existing issue already received a recent update.
