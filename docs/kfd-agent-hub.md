# KFD Agent Hub Builder Flow

Buildchain reduces Agent Hub adoption to one consumer declaration and one
adapter artifact. KFD owns the conformance profile, fixed suite, runner,
verifier, report schema, and failure codes. Buildchain owns orchestration,
source-cut locking, declaration-to-observation comparison, workflow artifacts,
agent explanations, and Release Passport binding.

## Declare one adapter

Create `.buildchain/kfd/agent-hub.json`:

```json
{
  "$schema": "https://buildchain.libkungfu.dev/schemas/kfd-agent-hub-adoption.schema.json",
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-kfd-agent-hub-adoption/v1",
  "profile": {
    "package": "@kungfu-tech/kfd",
    "id": "kfd-agent-hub-conformance"
  },
  "adapter": {
    "id": "example-agent-hub-adapter",
    "version": "0.1.0",
    "path": "dist/agent-hub-adapter.mjs",
    "build": ["pnpm", "run", "build:agent-hub"]
  },
  "capabilities": {
    "operations": ["capability-advertisement", "fact-admission"],
    "topologies": ["local-peer"],
    "hubBindings": ["local-file-bundle"]
  }
}
```

`adapter.build` is an argv array, not a shell command. Buildchain does not
accept a consumer-provided verifier command. It always invokes the installed
KFD package's fixed public commands:

```text
kfd test agent-hub --adapter <entry> --output <report.json>
kfd verify agent-hub-report <report.json> --adapter <entry> --json
```

`jsonl-stdio/v1` is the KFD runner-to-adapter invocation binding. It is locked
from the KFD profile and is deliberately separate from
`capabilities.hubBindings`, which declares product transport or file bindings
such as `local-file-bundle`.

## Inspect, test, and explain

```bash
buildchain kfd hub init --write
buildchain kfd hub inspect --for agent
buildchain kfd hub test --for agent
buildchain kfd hub explain --for agent
```

`inspect` resolves the installed `@kungfu-tech/kfd` package and locks its exact
package version, package manifest, release anchor, profile manifest, protocol
manifest, fixed suite root, failure inventory root, declaration, and adapter
artifact. Placeholder roots and KFD packages without the public Agent Hub
profile fail closed.

`test` runs the declared adapter build, delegates all semantic decisions to
KFD, verifies the KFD report, and then checks that every observed Hub
capability document exactly matches the declared operations, topologies, and
Hub bindings. Scope widening is a failure.

Evidence is written under `.buildchain/artifacts/kfd-agent-hub/`:

- `report.json`: the KFD-owned Agent Hub report.
- `adoption-lock.json`: exact KFD cut, declaration, adapter, and capability lock.
- `verification.json`: Buildchain's binding of the KFD verifier verdict to the lock.
- `evidence.json`: the portable, nonqualifying, non-certifying release evidence index.

The evidence proves only the named adapter artifact, KFD package cut, platform,
fixed suite, observed capability documents, and retained residual risks. It is
not KFD certification, a security assessment, or production-fitness evidence.

## Use the reusable workflow

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v3
    with:
      kfd-agent-hub: auto
```

`auto` runs the fixed Builder flow after the consumer verify lifecycle on every
selected platform and uploads
`<artifact>-kfd-agent-hub-<platform>-<source-sha>`. `off` is the default.

## Bind Release Passport

Pass the generated evidence index to the normal collector:

```bash
buildchain collect github-release \
  --tag "$TAG" \
  --assets-dir dist \
  --kfd-agent-hub-evidence-json .buildchain/artifacts/kfd-agent-hub/evidence.json
```

The collector embeds a `kfdAgentHub` section and bundles
`kfd-agent-hub-evidence.json`. `buildchain verify release-passport` resolves
that sibling asset and rejects report, lock, source-cut, scope, or claim-boundary
tampering.

