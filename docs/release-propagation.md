---
status: active
period: ongoing
theme: buildchain-release-propagation
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-03
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-03
  invisible_context: not asserted
---

# Release Propagation

Release propagation lets a finalized upstream release open a downstream update
PR using the upstream release passport as the audit source. It is for product
chains such as:

```text
kfd -> site-libkungfu-dev
A -> B -> C
```

The downstream repository receives an exact lock, not a floating dist-tag. A
site or app can then consume the upstream package, site bundle, or release
passport as its single source of truth without hand-copying release facts.

## Contract

The propagation graph is declarative JSON:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-release-propagation-graph",
  "nodes": [
    {
      "id": "kfd",
      "repository": "kungfu-systems/kfd",
      "package": "@kungfu-tech/kfd"
    },
    {
      "id": "site-libkungfu-dev",
      "repository": "kungfu-systems/site-libkungfu-dev",
      "lockPath": "buildchain.upstreams/kfd.release.json",
      "baseRef": "dev/v2/v2.7"
    }
  ],
  "edges": [
    {
      "id": "kfd-to-site",
      "from": "kfd",
      "to": "site-libkungfu-dev",
      "channelPolicy": "preserve"
    }
  ]
}
```

`channelPolicy: "preserve"` is the default and maps:

```text
alpha   -> alpha
release -> release
```

Cross-channel mapping is allowed only when an edge declares
`channelPolicy: "explicit"` and a `channelMap`. Buildchain rejects cycles so a
chain can fan out or continue as `A -> B -> C`, but cannot loop back into an
already visited release line.

## Upstream Release Envelope

The upstream release envelope is the post-finalization fact set:

```json
{
  "repository": "kungfu-systems/kfd",
  "channel": "alpha",
  "tag": "v1.4.0-alpha.3",
  "sourceSha": "1111111111111111111111111111111111111111",
  "tagTargetSha": "1111111111111111111111111111111111111111",
  "package": {
    "name": "@kungfu-tech/kfd",
    "version": "1.4.0-alpha.3",
    "integrity": "sha512-...",
    "gitHead": "1111111111111111111111111111111111111111"
  },
  "releasePassport": {
    "url": "https://github.com/kungfu-systems/kfd/releases/download/v1.4.0-alpha.3/buildchain.release.json",
    "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "siteBundle": {
    "manifestSha256": "3333333333333333333333333333333333333333333333333333333333333333"
  }
}
```

The package version, integrity, and npm `gitHead` must be exact. The exact tag
must be `v<version>`, and `gitHead`, tag target, and `sourceSha` must describe
the same source commit before propagation is admitted. Downstream build logic
installs that version directly and never resolves `alpha` or `latest` again.

Publication repositories can propagate immutable publication archive evidence
without npm package facts. The upstream envelope then includes
`publicationArtifact`:

```json
{
  "repository": "kungfu-systems/paper-observer-declared-timelines",
  "channel": "alpha",
  "tag": "v0.1.0-alpha.1",
  "sourceSha": "4444444444444444444444444444444444444444",
  "tagTargetSha": "4444444444444444444444444444444444444444",
  "releasePassport": {
    "url": "https://github.com/kungfu-systems/paper-observer-declared-timelines/releases/download/v0.1.0-alpha.1/buildchain.release.json",
    "sha256": "5555555555555555555555555555555555555555555555555555555555555555"
  },
  "publicationArtifact": {
    "id": "observer-declared-timelines",
    "kind": "paper",
    "version": "0.1.0-alpha.1",
    "canonicalUrl": "https://papers.libkungfu.dev/observer-declared-timelines/",
    "latestUrl": "https://papers.libkungfu.dev/observer-declared-timelines/latest/",
    "latestEvidenceUrl": "https://papers.libkungfu.dev/observer-declared-timelines/latest/buildchain.release.json",
    "immutableVersionUrl": "https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0-alpha.1/",
    "registry": {
      "url": "https://github.com/kungfu-systems/paper-observer-declared-timelines/releases/download/v0.1.0-alpha.1/publication-registry.json",
      "sha256": "6666666666666666666666666666666666666666666666666666666666666666"
    },
    "manifest": {
      "url": "https://github.com/kungfu-systems/paper-observer-declared-timelines/releases/download/v0.1.0-alpha.1/publication-artifact.json",
      "sha256": "7777777777777777777777777777777777777777777777777777777777777777"
    },
    "passport": {
      "url": "https://github.com/kungfu-systems/paper-observer-declared-timelines/releases/download/v0.1.0-alpha.1/publication-artifact-passport.json",
      "sha256": "8888888888888888888888888888888888888888888888888888888888888888"
    },
    "primaryArtifact": {
      "path": "_build/main.pdf",
      "url": "https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0-alpha.1/main.pdf",
      "sha256": "9999999999999999999999999999999999999999999999999999999999999999"
    }
  }
}
```

This lets a site repository render the latest reader page and historical
version index from release facts while keeping old PDFs, source bundles,
manifests, and passports immutable.

When the downstream consumer is expected to update an exact npm paper pin, the
upstream envelope must carry both `package` and `publicationArtifact`. The
consumer can then prove that package name, version, sha512 integrity,
publication URLs, and immutable artifact digests all describe the same release.
`publicationArtifact` without `package` remains valid for evidence-only
propagation, but it cannot qualify a package-pin fast path.

## CLI

Generate a propagation plan:

```bash
buildchain release-propagation plan \
  --graph buildchain.release-propagation.json \
  --upstream-release .buildchain/upstream-release.json \
  --output .buildchain/release-propagation-plan.json \
  --json
```

Write the downstream lock:

```bash
buildchain release-propagation write-lock \
  --plan .buildchain/release-propagation-plan.json \
  --target site-libkungfu-dev \
  --cwd downstream-checkout \
  --json
```

The written lock has contract
`kungfu-buildchain-release-propagation-lock` and records:

- upstream repository, channel, exact tag, source SHA;
- optional npm package name, exact version, and sha512 integrity;
- optional publication artifact canonical/latest/immutable URLs, registry,
  manifest, passport, source bundle, and primary artifact digests;
- release passport URL and SHA-256;
- optional site bundle manifest SHA-256;
- downstream repository, channel, base ref, lock path;
- edge id and channel policy;
- a deterministic propagation key and branch derived from the exact upstream
  repository/version/channel plus downstream repository.

Repeated runs for the same release identity reuse that branch and lock. A
different release version or channel receives a different branch, so concurrent
releases cannot collapse into one mutable propagation PR.

Create the exact propagation receipt after the lock/PR outcome is known:

```bash
buildchain release-propagation receipt \
  --plan .buildchain/release-propagation-plan.json \
  --lock-result .buildchain/release-propagation-write-lock.json \
  --pr-outcome .buildchain/release-propagation-pr-outcome.json \
  --target site-libkungfu-dev \
  --output .buildchain/release-propagation-receipt.json \
  --json
```

The receipt keeps four machine states separate:

- `package-published`: exact npm name/version/integrity exists;
- `alpha-complete`: the upstream alpha passport/tag is complete;
- `staging-visible`: the downstream staging surface is actually visible;
- `production-visible`: the production surface is actually visible.

Package publication or alpha completion never implies either visibility state.

## Unified Site agent entry

An Agent begins every Site upstream update through one policy-reporting entry:

```bash
buildchain release-propagation entry plan \
  --source-id <paper|kfd|buildchain|kungfu-core> \
  --channel <alpha|release> \
  --json
```

The entry does not blur content and code release policies:

| Upstream    | Trigger policy            | Entry result                                       |
| ----------- | ------------------------- | -------------------------------------------------- |
| Paper       | automatic release handoff | requires or resumes the exact captured Work        |
| KFD         | automatic release handoff | requires or resumes the exact captured Work        |
| Buildchain  | explicit Site intent      | resolves an exact published package before capture |
| Kungfu Core | explicit Site intent      | resolves an exact published package before capture |

Paper and KFD releases keep automatic capture-only handoff. Buildchain and
Kungfu Core releases remain inert until a downstream Agent receives explicit
Site-update intent. In all four cases, the entry reports the selected policy,
exact release coordinate when one has been admitted, Work root and recovery
cursor when one exists, and one machine-readable next action. A GitHub PR is a
delivery stage inside that Work; it is not the handoff unit.

For an automatic handoff, bind the exact artifact rather than resolving a
floating tag again:

```bash
buildchain release-propagation entry plan \
  --source-id kfd \
  --handoff-work work.json \
  --json
```

The deterministic recovery table is available without repository mutation:

```bash
buildchain release-propagation entry fault-matrix --json
```

It classifies current and duplicate Work as successful no-ops, supersession as
an explicit decision boundary, stale base/expected-old and operational failures
as retryable, and package/schema disagreement as a hard safety gate.

## Agent-native work envelope

Setting `agent-work-mode: capture-only` makes a finalized release emit a
resumable delivery handoff without mutating the downstream repository. Passing
an exact `agent-work-context-json` instead emits an already-authorized unit.
Buildchain emits one
`kungfu-buildchain-release-propagation-work` v1 envelope per exact release and
downstream target. This is a Buildchain domain execution contract, not another
Work Control database or authority.

The envelope binds:

- the exact normalized upstream release and release-lock roots;
- the downstream repository, channel, base ref, expected base SHA, managed
  branch, lock path, and propagation key;
- exact parent and child `kungfu.assignment-graph.work-ref/v1` values derived
  from the immutable release and downstream plan;
- either a pending Family binding or one exact
  `kungfu.work-control.initiative-family-state/v2` coordinate;
- capture-only or end-to-end execution authority, including an active typed
  execution-Warrant reference for execution;
- explicit publish-to-production intent, deterministic commands, canonical
  ordered stages, a recovery cursor, stage receipts, supersession policy, and
  a content root.

The ordered stages are:

```text
materialize -> verify-release -> push-branch -> pull-request -> preview
-> independent-review -> protected-merge -> staging -> production-release
-> production-deploy -> online-readback -> complete
```

`pull-request` and `protected-merge` are intermediate states. Only exact online
readback followed by an accepted Work Control Decision can record `complete`.
Every state transition uses expected-old fencing against the current work
content root. An identical initial envelope has the same work id and root;
newer releases receive distinct propagation keys and must name an explicit
superseded work root when they replace unfinished work.

The context has this shape (roots abbreviated here only for readability):

```json
{
  "parentWorkRef": {
    "schema": "kungfu.assignment-graph.work-ref/v1",
    "workspace_identity_root": "sha256:<64 hex>",
    "object_kind": "initiative",
    "subject": "paper-publication",
    "version_root": "sha256:<64 hex>",
    "cut_root": "sha256:<64 hex>"
  },
  "childWorkRef": {
    "schema": "kungfu.assignment-graph.work-ref/v1",
    "workspace_identity_root": "sha256:<64 hex>",
    "object_kind": "assignment",
    "subject": "site-propagation",
    "version_root": "sha256:<64 hex>",
    "cut_root": "sha256:<64 hex>"
  },
  "familyState": {
    "schema": "kungfu.work-control.initiative-family-state/v2",
    "stateRoot": "sha256:<64 hex>",
    "v1ProjectionRoot": "sha256:<64 hex>",
    "typedBindingRoot": "sha256:<64 hex>",
    "factWorld": "<owning fact world>",
    "cutRoot": "sha256:<64 hex>"
  },
  "authority": {
    "mode": "capture-only",
    "publishToProduction": false,
    "allowedActions": [],
    "executionPrincipal": null,
    "sourceControlPrincipal": null,
    "executionWarrant": null
  },
  "supersedesWorkRoot": ""
}
```

Automatic capture emits deterministic Buildchain-owned release and propagation
WorkRefs, leaves `workControl.bindingState` as `pending`, emits no Family State
or Warrant, and performs no downstream write. Claiming that unit supplies the
exact Family State v2 coordinate and active Warrant while preserving the work
identity. An executing input must carry an active Warrant at the same Family
State fact world and cut, explicit production intent, and the complete supported
action set. It also binds the acting Agent principal and the source-control
principal that authors the PR. Buildchain never invents external Work Control
authority.

A managed Paper opts into automatic capture with a thin, source-controlled
`.buildchain/release-propagation.json`. The sealed release workflow reads that
exact file from the released Paper SHA only after npm, tag, Passport, and
publication evidence agree. It emits one paused work artifact per declared
target; publication itself does not open a Site PR.

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-paper-release-propagation",
  "sourceNode": "paper-example",
  "graph": {
    "schemaVersion": 1,
    "contract": "kungfu-buildchain-release-propagation-graph",
    "nodes": [],
    "edges": []
  },
  "targets": ["site-libkungfu-dev"]
}
```

A managed npm package uses the parallel generic contract and passes its path to
the release-candidate promotion workflow:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-package-release-propagation",
  "sourceNode": "kfd",
  "graph": {
    "schemaVersion": 1,
    "contract": "kungfu-buildchain-release-propagation-graph",
    "nodes": [],
    "edges": []
  },
  "targets": ["site-libkungfu-dev"]
}
```

```yaml
with:
  release-propagation-config-path: .buildchain/release-propagation.json
```

The config is read with `git show` from the exact finalized release SHA. Its
root fields, graph fields, nodes, edges, targets, and execution profiles reject
unknown fields. After npm publication and the public GitHub Release are
complete, Buildchain independently reads npm `version`, `dist.integrity`, and
`gitHead`, resolves annotated Git tags to their commit, downloads the public
`buildchain.release.json` asset, and compares its bytes with the finalized
Passport. Only an exact source SHA, tag target, npm `gitHead`, package version,
integrity, and Passport digest can produce the capture artifact. The promotion
output `release-propagation-work-artifact` names the restart-safe artifact set.
No downstream checkout, branch, or pull request is created by this step.

Each graph target owns an exact GitHub web-surface execution profile: workflow,
base and managed branch, lock path, consumer commands, production status URL,
and production artifact readback URLs. The sealed workflow rejects extra config
fields, unknown targets, or a target whose base revision cannot be resolved.

The reusable workflow keeps its prior behavior when `agent-work-mode` is
`legacy` (the default). Managed Paper callers set `capture-only`; an Agent later
claims the emitted artifact and resumes from its machine-readable `next_action`.

Agent entrypoints are machine-readable and restart-safe:

```bash
buildchain release-propagation work create ... --output work.json --json
buildchain release-propagation work status --work work.json --json
buildchain release-propagation work resume --work work.json --json
buildchain release-propagation work claim ... --output successor.json --json
buildchain release-propagation work receipt ... --output receipt.json --json
buildchain release-propagation work record ... --output successor.json --json
buildchain release-propagation work repair ... --output successor.json --json
buildchain release-propagation work complete ... --output successor.json --json
```

The `push-branch` stage has an executable, fail-closed entrypoint:

```bash
buildchain release-propagation work push-plan \
  --work work.json \
  --expected-work-root sha256:<64-hex> \
  --cwd downstream-worktree \
  --remote origin \
  --json

buildchain release-propagation work push-branch \
  --work work.json \
  --expected-work-root sha256:<64-hex> \
  --cwd downstream-worktree \
  --remote origin \
  --execute \
  --json
```

The executor checks the exact GitHub repository, current managed branch,
captured downstream base, and expected-old Work root. It pushes only the current
commit with `HEAD:refs/heads/<managed-branch>`, never a bare branch or wildcard,
never a force option, then reads that exact remote ref back. Its typed branch
reconciliation evidence records the argv, source SHA, destination ref, prior
remote SHA, observed remote SHA, and whether a mutation occurred. A wrong
repository, unrelated branch, stale base, concurrent writer, or non-fast-forward
target fails closed without mutating another branch.

Known operational races (`stale-branch`, `expected-old-mismatch`,
`lockfile-drift`, `failed-check`, `interrupted-execution`, and `ci-delay`) return
a retryable repair action. Semantic ambiguity, missing credentials, policy
expansion, and unknown failures stop at `needs-decision`. Release-contract
mismatch, immutable-artifact conflict, and destructive recovery stop at a hard
safety gate. Evidence locators containing signed or credential parameters are
rejected.

Successful stage receipts are typed, not generic progress notes. In particular,
the pushed-branch receipt hashes the full expected-old branch reconciliation;
review binds an approved GitHub review and must come from an identity distinct
from both the acting Agent and PR author; production deployment carries release,
lock, deployed artifact, expected readback digest, and rollback coordinates; and
online readback must cover the exact execution-profile URLs with HTTP 200,
observed non-zero bytes, exact deployed Git revision, and matching release and
artifact digests. The final receipt binds the accepted Work Control Decision
root.

## Reusable Workflow

Upstream repositories can call
`.github/workflows/release-propagation.yml@v3` after release finalization:

```yaml
jobs:
  propagate-site:
    uses: kungfu-systems/buildchain/.github/workflows/release-propagation.yml@v3
    with:
      buildchain-ref: v3
      graph-json: ${{ needs.release.outputs.propagation-graph-json }}
      upstream-release-json: ${{ needs.release.outputs.upstream-release-json }}
      downstream-target: site-libkungfu-dev
      downstream-repository: kungfu-systems/site-libkungfu-dev
      downstream-base-ref: dev/v2/v2.7
      downstream-update-command: >-
        node scripts/paper-propagation.cjs consume
        --lock "$BUILDCHAIN_PROPAGATION_LOCK_PATH"
        && corepack pnpm install --lockfile-only --ignore-scripts
      downstream-prepare-command: pnpm install --frozen-lockfile --ignore-scripts
      downstream-verify-command: pnpm run check
      dry-run: false
    secrets:
      propagation-token: ${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
```

The downstream branch name may be reused across upstream releases. Before
replacing an existing managed branch, the workflow reads its exact remote SHA
and pushes with an explicit `--force-with-lease=<ref>:<sha>`. A surviving branch
from a merged PR is therefore reconciled without manual deletion, while a
concurrent writer makes the lease fail closed. The controller receipt includes a
`propagation-branch-reconciliation` evidence file recording the branch, observed
remote SHA, pushed SHA, lease mode, and the deterministically created or updated
open PR.

The workflow checks out the Buildchain runtime selected by
`buildchain-repository` and `buildchain-ref` into `.buildchain/runtime`, invokes
that runtime for the propagation plan and lock write, then checks out the
downstream repository and writes the exact lock. If
`downstream-update-command` is set, Buildchain runs that consumer-owned command
after writing the lock and exposes the exact lock path, lock SHA-256,
propagation key, branch, and upstream release JSON as
`BUILDCHAIN_PROPAGATION_*` environment variables. The command is part of the
downstream PR diff; it is not a deployment hook.

A consumer that must perform further deterministic preparation can declare
`downstream-prepare-command`. The command receives
`BUILDCHAIN_UPSTREAM_PACKAGE_NAME`, `BUILDCHAIN_UPSTREAM_PACKAGE_VERSION`, and
`BUILDCHAIN_UPSTREAM_RELEASE_LOCK`. After preparation, Buildchain refreshes an
existing `<!-- buildchain:badges:start -->` README block by default. Consumers
can disable that step with `refresh-managed-readme-badges: false`.

`downstream-verify-command` runs against the final tree before any commit or
push, so consumers can use the same check as their PR workflow. Update,
preparation, badge refresh, and verification failures all fail closed. The
workflow stages the complete deterministic result, signs the propagation
commit with DCO, and then opens or updates the PR. With no agent work context,
the reusable workflow retains this backward-compatible PR boundary. With an
executing work context, it records materialization, verification, branch, and
PR receipts and returns `preview` as the next action; the authorized Agent then
continues through the downstream repository's normal protected review,
publication, deployment, and readback entrypoints. A byte-identical rerun is an
explicit successful no-op, never a synthetic completion.

For unreleased runtime validation, keep the caller's reusable workflow reference
on `@v3` and pass a temporary train ref through `buildchain-ref`.

## kfd to site-libkungfu-dev

For `kfd -> site-libkungfu-dev`, the graph should preserve channels:

- a `kfd` alpha release produces a downstream alpha lock and downstream alpha
  publication consumes the exact `@kungfu-tech/kfd@...-alpha.N` package;
- a `kfd` stable release produces a downstream release lock and downstream
  stable publication consumes the exact stable package.

This keeps the site synchronized to the package truth without allowing the site
to drift onto a floating npm dist-tag.
