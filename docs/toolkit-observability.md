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
  collectCompilerCacheDiagnostics,
  collectRunnerDiagnostics,
  collectToolDiagnostics,
  detectRequestedParallelism,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
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
const cacheDiagnostics = collectCacheDiagnostics({ cwd: process.cwd() });

writeDiagnosticsArtifact(".buildchain/artifacts/diagnostics.json", {
  contract: "consumer-build-diagnostics",
  buildchain: collectBuildchainDiagnostics({ cwd: process.cwd() }),
  runner: collectRunnerDiagnostics(),
  tools: collectToolDiagnostics({ cwd: process.cwd() }),
  cache: cacheDiagnostics,
  lifecycleObservability,
  process: processSummary,
});
```

`collectCacheDiagnostics()` includes package-manager/workspace context, selected
cache directory stats, and compiler-cache stats from `ccache --show-stats
--json` plus `sccache --show-stats --stats-format json` when those tools are
present. Missing cache tools are recorded as unavailable instead of failing the
diagnostics artifact. Call `collectCompilerCacheDiagnostics()` directly when a
consumer script only needs compiler cache data.

Process samples are intentionally summarized before they become long-lived
artifacts. The summary records requested parallelism, the source of that value
(`command`, `env:MAKEFLAGS`, `env:CMAKE_BUILD_PARALLEL_LEVEL`, or `explicit`),
observed active process concurrency, elapsed sample time, total sampled CPU,
and conservative command categories such as `compiler`, `archive`, `linker`,
`build-tool`, and `cache`. This lets native projects distinguish "we asked for
`make -j20`" from "the build graph only kept two active compiler or archive
children busy during the sampled window" without storing full command lines.

Native repositories can opt into a reusable diagnostics profile in
`buildchain.toml`:

```toml
[diagnostics.native]
enabled = true
sample_process_tree = true
compiler_cache = "auto"
expected_tools = ["ccache", "sccache", "clang", "cl", "cmake", "ninja"]
artifact_dirs = ["build", "dist", "build/Release"]
cache_dirs = [".ccache", ".sccache"]
```

When enabled, diagnostics artifacts include the normalized profile, selected
tool versions, compiler-cache stats, and configured artifact/cache directory
stats. The profile is data-driven: Buildchain does not assume a specific
project such as libnode. The reusable build workflow also exposes
`sample-process-tree`, which wraps the build lifecycle with the process sampler
and carries the generated summary into the final diagnostics artifact. Custom
workflows can call `buildchain sample process-tree` directly when they need a
different command boundary.

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
platform manifest by default. The per-platform diagnostics upload includes the
compact `diagnostics.json`, lifecycle `events.jsonl`, and, when process sampling
is enabled, copied `process-summary.json` and `process-samples.jsonl` sidecars.
It is intended to stay small enough to download without fetching large binary
packages, and it should not include full environment dumps or secret-looking
values.

Use `summarizeDiagnosticsArtifacts()` when a matrix build uploads one
diagnostics artifact per platform. The summary keeps each platform's lifecycle
stage table, adds a lifecycle total duration, carries the top slow spans, and
aggregates warning/error counts plus the slowest platforms. Slow platform rows
also include a compact process sampler view with requested parallelism, observed
max active processes, the ratio between them, sample count, process categories,
and top sampled command basenames. That gives release reviewers a small
cross-platform timing and concurrency view without downloading full build
outputs or process sidecars.

The CLI exposes the same aggregation for shell and workflow steps:

```bash
buildchain diagnostics summary \
  .buildchain/artifacts/linux-x64/diagnostics.json \
  .buildchain/artifacts/macos-arm64/diagnostics.json \
  --output .buildchain/artifacts/diagnostics-summary.json \
  --json
```

Omit `--json` when the workflow log should show a compact platform table with
lifecycle stages, artifact scan/upload time, total time, requested jobs,
observed active processes, warnings, and errors.

For long native build commands, the CLI can also sample the child process tree
while preserving the wrapped command's exit code:

```bash
buildchain sample process-tree \
  --label native-build \
  --interval-ms 15000 \
  --output .buildchain/diagnostics/process-samples.jsonl \
  --summary-output .buildchain/diagnostics/process-summary.json \
  -- \
  make -j20
```

The JSONL sample file stores timestamped process-tree snapshots with command
basenames, CPU percentages, elapsed time, and requested parallelism context. The
summary file records observed concurrency, total sampled CPU, command
categories, and top command basenames. This is intended for diagnosing
low-utilization tails such as archive/link phases without logging full command
lines or environment dumps.

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
