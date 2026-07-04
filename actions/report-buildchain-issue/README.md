# report-buildchain-issue

Create or update a Buildchain repository issue from a consumer workflow.

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
- common token, private-key, password, and authorization values are redacted
  before submission.

Use `dry-run: "true"` to verify the computed fingerprint and body shape without
calling GitHub.
