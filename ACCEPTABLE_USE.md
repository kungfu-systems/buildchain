# Acceptable Use Policy

This policy applies to official Buildchain services and maintainer-operated
infrastructure. It does not change the Apache-2.0 license for the source code in
this repository.

Examples of official services and infrastructure may include official package
distribution, release promotion infrastructure, hosted release evidence,
maintainer-run CI, managed deployment helpers, official support channels, and
other maintainer-operated Buildchain services.

## Allowed Purpose

Official Buildchain services are intended to help projects create auditable
release records: reviewed promotion, exact artifacts, release passports,
machine-readable evidence, and reproducible trust checks.

Users remain responsible for:

- the repositories, packages, artifacts, and deployments they release;
- the credentials, secrets, accounts, runners, and environments they connect;
- complying with laws, upstream provider terms, and organization policies that
  apply to their use.

## Disallowed Use

Do not use official Buildchain services or infrastructure to:

- access systems, accounts, data, repositories, packages, registries, or cloud
  resources without authorization;
- steal, expose, sell, or mishandle credentials, tokens, session data, secrets,
  private keys, customer data, or private logs;
- bypass provider billing, quota, rate limits, approval flows, safety controls,
  repository protections, environment protections, provenance checks, or access
  controls;
- publish malicious packages, compromised artifacts, forged release evidence, or
  misleading release passports;
- misrepresent unofficial software, services, action bundles, release passports,
  packages, or forks as official Buildchain offerings;
- overload, degrade, probe, or attack official Buildchain infrastructure or
  upstream provider infrastructure;
- use official services in a way that creates legal, security, abuse, or trust
  risk for users, maintainers, release consumers, or upstream providers.

## Release Evidence

Buildchain's release evidence should make release intent and artifact identity
more transparent. Do not use official Buildchain services to hide who promoted a
release, what ref was promoted, what artifact was produced, what provider
action was taken, or which credentials were involved.

## Enforcement

The maintainers may refuse, suspend, limit, or terminate access to official
services or infrastructure for uses that violate this policy or create material
risk. They may also remove misleading official-brand claims from project
channels or package distribution surfaces they control.

Where practical, maintainers may contact affected users before taking action.
Immediate action may be taken for security incidents, abuse, infrastructure
risk, provider-risk incidents, misleading official-brand use, or compromised
release evidence.

## Security Reports

Report vulnerabilities, credential exposure, compromised release evidence, or
service-abuse issues through the private reporting path in `SECURITY.md`, not
through public issues.

