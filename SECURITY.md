# Security Policy

## Reporting vulnerabilities

Please report security issues privately instead of opening a public issue.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**
([open directly](https://github.com/kungfu-systems/buildchain/security/advisories/new)).
The report stays private to the maintainers until a fix is coordinated.

Do not report vulnerabilities through public issues, pull requests, or
discussions.

Include:

- affected version, commit, action, workflow, package, or release artifact;
- repository and workflow configuration needed to reproduce;
- operating system, runner type, and architecture when relevant;
- steps to reproduce;
- expected impact;
- whether the issue affects release governance, publish evidence, reusable
  workflow behavior, CLI behavior, package publishing, or artifact provenance.

## Scope

Security reports may cover:

- release ref, tag, or version-state integrity;
- publish transaction evidence, recovery, or replay behavior;
- trusted event gating for self-hosted runners or secrets;
- publish-gate source locking and stale source detection;
- GitHub Actions permission, token, or OIDC misuse;
- package, artifact, npm, S3, OCI, or deployment-chain behavior;
- local file access, path traversal, or unsafe archive handling;
- credential, token, or private data exposure.

## Public disclosure

Please allow maintainers time to investigate and prepare a fix before public
disclosure. The project will coordinate disclosure timing with reporters when a
confirmed vulnerability affects released artifacts or reusable workflow
consumers.
