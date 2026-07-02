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

These surfaces require at least a minor bump when first introduced:

- reusable workflow inputs, outputs, and artifact contracts;
- public CLI command families and their machine-readable JSON shapes;
- public npm exports such as `@kungfu-tech/buildchain/logging`;
- config protocols such as `buildchain.toml`;
- release governance state machines and protected ref semantics;
- release evidence contracts such as passport, artifact evidence, impact
  ledger, and agent index files;
- binary distribution shapes that users can install or automate against.

Additive fields inside an existing welded surface can be patch releases when
old consumers continue to work and validation remains stricter, not looser.
Removing fields, changing meanings, weakening trust gates, or changing the
expected ref flow requires a major bump.

## Decision Log

| Date | Decision | Line | Reason |
| --- | --- | --- | --- |
| 2026-07-02 | Buildchain toolkit observability is a minor surface. | `v2.1` | It adds the public logging SDK, CLI observability commands, and package subpaths that consumers can import. |
| 2026-07-02 | Release passport and binary distribution are a minor surface. | `v2.2` | They add agent-readable release passport files, artifact evidence, impact ledger, agent index, GitHub Release collection and verification commands, and standalone binary assets. |

## Runner Policy

The `v2.2` binary distribution lane uses GitHub-hosted runners for production
assets because that is the easiest release path for external users to reproduce:

- `ubuntu-24.04`
- `macos-latest`
- `windows-2022`

Self-hosted runners remain compatibility fixtures. They prove Buildchain's
protocol does not depend on GitHub-hosted images, but they do not define the
public binary distribution path.
