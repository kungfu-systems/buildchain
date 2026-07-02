# Toolkit Observability

Buildchain ships a small logging toolkit for repository workflows and project
scripts. The goal is to separate time spent in Buildchain's framework from time
spent in the consumer's own build, test, packaging, and publish steps.

## Choose API or CLI

`@kungfu-tech/buildchain` is not only a CLI package. It exports ESM toolkit APIs
that project scripts can import directly:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";
```

Use the API inside JavaScript or TypeScript build code. Do not spawn
`buildchain`, download the standalone binary, or shell out through `npx` from
code that can import the package. The CLI is for GitHub Actions steps, shell
scripts, and non-JavaScript tools.

When a script runs inside `buildchain lifecycle run`, the lifecycle runner sets
`BUILDCHAIN_LOG_PATH` and `BUILDCHAIN_LOG_RUN_ID`. Imported loggers pick up those
environment variables automatically, so events emitted deep inside the build are
grouped into the same lifecycle summary.

Outside a Buildchain lifecycle or GitHub Actions run, the logger defaults to
console output unless a path is provided. Pass `path` when local scripts should
write a reusable JSONL log:

```js
const logger = createBuildchainLogger({
  path: ".buildchain/logs/native-build.jsonl",
  source: "user",
  component: "native-build",
});
```

## Library API

```js
import {
  createBuildchainLogger,
  verifyBuildchainLogEvents,
} from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({
  source: "user",
  component: "native-build",
});

logger.mark("configure.ready", {
  phase: "configure",
  attributes: { preset: "release" },
});

await logger.span("native.compile", {
  phase: "build",
  attributes: { target: "release" },
}, async () => {
  await compile();
});

logger.spanSync("native.archive", {
  phase: "build",
  attributes: { tool: "libtool" },
}, () => {
  archiveStaticLibraries();
});

logger.spawnSync("native.build", "make", ["-j20"], {
  stdio: "inherit",
}, {
  phase: "build",
  attributes: { requestedJobs: 20 },
});

const report = verifyBuildchainLogEvents({
  path: logger.path,
  minEvents: 3,
  requirePhases: ["configure", "build"],
  requireEvents: [
    "configure.ready",
    "native.compile.start",
    "native.compile.end",
  ],
});

if (!report.ok) {
  throw new Error("Buildchain observability verification failed");
}
```

Use the API when a build script has internal stages that are invisible to the
outer workflow. Keep secret values out of attributes; known sensitive keys are
redacted, but callers should still avoid logging private material.

CommonJS scripts should import Buildchain's ESM surfaces dynamically:

```js
const { createBuildchainLogger } = await import("@kungfu-tech/buildchain/logging");
const { collectRunnerDiagnostics } = await import("@kungfu-tech/buildchain/diagnostics");
```

## Diagnostics API

The diagnostics surface collects local, non-telemetry build facts that are
useful when a native build is slow or flaky:

```js
import {
  collectBuildchainDiagnostics,
  collectCacheDiagnostics,
  collectRunnerDiagnostics,
  collectToolDiagnostics,
  detectRequestedParallelism,
  startProcessSampler,
  summarizeLifecycleObservability,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
  writeDiagnosticsArtifact,
} from "@kungfu-tech/buildchain/diagnostics";

const lifecycleObservability = summarizeLifecycleObservability({
  logPath: ".buildchain/logs/events.jsonl",
});
const buildCommand = "make";
const buildArgs = ["-j20"];
const requestedParallelism = detectRequestedParallelism({
  command: buildCommand,
  args: buildArgs,
});
const processSampler = startProcessSampler({
  intervalMs: 15000,
  label: "native-build",
  command: buildCommand,
  args: buildArgs,
});
// Run the long native build while the sampler is active.
const processSummary = summarizeProcessSamples({
  requestedParallelism: requestedParallelism.value,
  samples: processSampler.stop(),
});

writeDiagnosticsArtifact(".buildchain/artifacts/diagnostics.json", {
  contract: "consumer-build-diagnostics",
  buildchain: collectBuildchainDiagnostics({ cwd: process.cwd() }),
  runner: collectRunnerDiagnostics(),
  tools: collectToolDiagnostics({ cwd: process.cwd() }),
  cache: collectCacheDiagnostics({ cwd: process.cwd() }),
  lifecycleObservability,
  process: processSummary,
});
```

Process samples are intentionally summarized before they become long-lived
artifacts. The summary records requested parallelism, the source of that value
(`command`, `env:MAKEFLAGS`, `env:CMAKE_BUILD_PARALLEL_LEVEL`, or `explicit`),
observed active process concurrency, elapsed sample time, total sampled CPU,
and conservative command categories such as `compiler`, `archive`, `linker`,
`build-tool`, and `cache`. This lets native projects distinguish "we asked for
`make -j20`" from "the build graph only kept two active compiler or archive
children busy during the sampled window" without storing full command lines.

Anchored/manual package projects can also run one higher-level release-shape
check instead of assembling lower-level config calls:

```js
const anchoredReport = validateAnchoredPackageRelease({
  cwd: process.cwd(),
  requireManifest: true,
  requirePackageSetOrder: "platforms-first-main-last",
  requireTrustedPublishing: true,
});

if (!anchoredReport.ok) {
  throw new Error("Anchored package release contract failed");
}
```

`buildchain lifecycle run` writes this small diagnostics artifact next to the
platform manifest by default. It is intended to stay small enough to download
without fetching large binary packages, and it should not include full
environment dumps or secret-looking values.

The lifecycle observability summary is stage-wide, not just final-step timing:
when install and build write to the same Buildchain log, the final platform
manifest can show both stages and the slowest spans.

## CLI Logging

```bash
buildchain mark \
  --event native.configure \
  --phase configure \
  --component cmake \
  --attribute preset=release

buildchain span \
  --event native.build \
  --phase build \
  --component cmake \
  -- cmake --build build --config Release

buildchain log summary --json
buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4
```

Every event records a timestamp. `span` records duration and preserves the
wrapped command's exit code.

## Release Gate

Buildchain's own binary distribution lane verifies required log events before
uploading release assets. Consumers can apply the same pattern:

```bash
buildchain verify observability-log .buildchain/logs/events.jsonl \
  --require-phase build \
  --require-phase package \
  --require-component workflow \
  --require-event native.build.start \
  --require-event native.build.end
```

This makes missing instrumentation a release failure instead of a dashboard
afterthought.
