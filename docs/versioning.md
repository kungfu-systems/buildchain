# Buildchain Versioning

Buildchain uses semantic version lines to describe public contracts, not only
code size. A release can be small in diff size and still open a new minor line
when it adds a durable surface that consumers, workflows, or agents can depend
on.

## Lines

| Line | Meaning |
| --- | --- |
| Patch | Compatible fix, hardening, documentation correction, or implementation repair inside an existing surface. |
| Minor | New compatible welded surface: reusable workflow output, CLI command family, config protocol, published subpath, evidence file, runner contract, or agent-readable artifact. |
| Major | Breaking semantic change, removed stable surface, changed branch/tag governance, or incompatible protocol rewrite. |

Kungfu minor lines are long-lived trains. `v2.0`, `v2.1`, and `v2.2` can each
receive many patch releases. The major ref, such as `v2`, points at the
selected stable major entrypoint; the minor ref, such as `v2.2`, points at the
latest stable production patch for that minor line.

## Welded Surfaces

These surfaces are classified independently; the final release impact is the
highest impact across the affected registered surfaces:

- reusable workflow inputs, outputs, and artifact contracts;
- public CLI command families and their machine-readable JSON shapes;
- public npm exports such as `@kungfu-tech/buildchain/logging`;
- config protocols such as `buildchain.toml`;
- release governance state machines and protected ref semantics;
- release evidence contracts such as passport, artifact evidence, impact
  ledger, and agent index files;
- binary distribution shapes that users can install or automate against.

For each surface:

- content, documentation, or implementation-only work that does not touch a
  registered surface is patch;
- additive fields, new commands, new exports, new evidence sections, or new
  registered surfaces are minor;
- removals, incompatible renames, changed meanings, newly required fields,
  weakened trust gates, or changed ref flow are major.

The release passport records this as `surfaceImpacts[]` plus
`versionImpact.final`. The final impact must equal the highest surface impact,
so an agent cannot silently label a release patch when one machine surface needs
minor review.

`surfaceImpacts[]` is mandatory for production release passports (`release/*`)
and major publish-gate passports. Alpha, local, and legacy passport contexts
keep the field optional so temporary validation can proceed without pretending
to be a production release decision.

Example: a KFD document such as KFD-2 is content and remains patch, but adding a
`kind` field to the machine-consumed KFD `registry.json` is an additive change
to the `kfd-registry-schema` surface and therefore requires minor-impact
review. This avoids both false shortcuts: "new KFD means minor" and "all KFD
repository changes are patch".

## Decision Log

| Date | Action | Line | Faces | Class | Rationale | PR |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-04 | open-minor | `v2.5` | scheduled-integration-governance | additive | Scheduled integration governance adds scheduled feature-branch discovery, conflict-free integration, reporting, and agent-visible governance automation for dev-line maintenance. | |
| 2026-07-03 | open-minor | `v2.4` | infra-contract-lifecycle | additive | Infra contract lifecycle adds the provider-neutral `infra-contract` CLI command family, project type, adapter capability contract, lifecycle evidence bundle, propagation evidence, CI evidence mode, and consumer-facing contract artifacts. | |
| 2026-07-02 | open-minor | `v2.3` | web-surface-host-mapping | additive | Web surface host mapping adds first-class multi-host surface bindings, reusable workflow URL outputs, per-surface deployment overrides, and an agent-readable fixture contract. | |
| 2026-07-02 | open-minor | `v2.2` | release-passport, binary-distribution | additive | Release passport and binary distribution add agent-readable release passport files, artifact evidence, impact ledger, agent index, GitHub Release collection and verification commands, and standalone binary assets. | |
| 2026-07-02 | open-minor | `v2.1` | logging-sdk, cli-observability, package-subpaths | additive | Buildchain toolkit observability adds the public logging SDK, CLI observability commands, and package subpaths that consumers can import. | |

## Runner Policy

The `v2.2` binary distribution lane uses GitHub-hosted runners for production
assets because that is the easiest release path for external users to reproduce:

- `ubuntu-24.04`
- `macos-latest`
- `windows-2022`

Self-hosted runners remain compatibility fixtures. They prove Buildchain's
protocol does not depend on GitHub-hosted images, but they do not define the
public binary distribution path.
