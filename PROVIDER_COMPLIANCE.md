# Provider Compliance Policy

Buildchain integrates with source hosts, CI providers, package registries,
release platforms, cloud services, and deployment targets. This policy records
the official integration posture.

The official project should make releases more observable, reviewable, and
verifiable. It should not become a tool for bypassing upstream provider rules.

## Official Integration Posture

Official Buildchain integrations should use provider-supported or public
surfaces, such as:

- documented APIs and SDKs;
- GitHub Actions and documented workflow permissions;
- documented package-registry publishing flows, including trusted publishing
  where available;
- documented cloud-provider APIs, OIDC roles, and least-privilege deployment
  permissions;
- explicit user-provided credentials, repository secrets, environment
  protections, or organization settings.

Official integrations should preserve the user's and maintainer's ability to
understand:

- which provider was used;
- which repository, package, artifact, runner, environment, or credential
  boundary was involved;
- what action was taken;
- which ref, tag, version, release passport, or artifact evidence record was
  produced;
- how a consumer can verify the published result.

## Prohibited Official Integration Patterns

Official Buildchain code and services must not intentionally:

- bypass repository protections, branch protections, environment approvals,
  provenance checks, package-registry controls, provider rate limits, billing
  systems, or access controls;
- hide provider identity, package identity, runner identity, release identity, or
  credential boundaries from maintainers or release consumers;
- scrape private web application state when a documented API, CLI, event, or
  export surface is the appropriate integration path;
- read browser cookies, private session databases, hidden provider auth files,
  billing pages, or local session stores to obtain provider access or usage
  data;
- share hidden provider accounts, rotate pooled credentials, or proxy release
  work through maintainer-owned accounts without clear terms and user consent;
- forge release passport evidence or mislabel artifact provenance;
- encourage users to violate upstream provider terms.

## Credential And Permission Model

Buildchain should prefer:

- least-privilege provider tokens;
- short-lived credentials and OIDC federation where providers support them;
- repository or environment protections for sensitive deployment targets;
- explicit configuration for package registries and cloud deployment targets;
- release evidence that records what happened without exposing secrets.

Buildchain must not print, upload, or package secrets into release artifacts,
release passports, logs, or diagnostics.

## Provider Requests

If an upstream provider reports that an official Buildchain integration creates
abuse, security, compliance, or infrastructure risk, maintainers should:

1. identify whether the behavior is official code, official service behavior, a
   third-party fork, or user configuration;
2. preserve enough evidence to understand the affected integration path without
   exposing user secrets;
3. disable, limit, or patch official behavior when needed;
4. clarify public documentation when the boundary was ambiguous.

This policy does not make the official project responsible for every third-party
fork or downstream use. It defines the posture of the official project and the
services maintained by its maintainers.

