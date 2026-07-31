---
status: draft
period: ongoing
theme: buildchain-observability
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-31
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-31
  invisible_context: not asserted
---

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

## Candidate timelines and critical-path-safe timing

Lifecycle diagnostics retain their existing summed-duration tables for
compatibility. Do not interpret those tables as elapsed time when spans are
nested or jobs run in parallel. Use the candidate timeline contract when a
change must be followed from pull-request admission through Merge Queue attempts
to its final merge:

```js
import {
  createCandidateTimeline,
  formatCandidateTimelineReport,
} from "@kungfu-tech/buildchain/candidate-timeline";

const timeline = createCandidateTimeline({
  candidate: {
    repository: "owner/repository",
    baseBranch: "dev/v4/v4.0",
    sourceSha,
    pullRequest: 123,
  },
  events,
});

console.log(formatCandidateTimelineReport(timeline));
```

Each event binds a stable event id to one attempt id and may also bind a Gate
id, merge-group SHA, workflow run, platform, partition, cache outcome, execution
boundary, and parent span. Terminal execution states (`success`, `failure`, and
`cancelled`) require start and completion timestamps. Non-executed states use
`skipped`, `dependency-blocked`, or `not-required` without invented timings.
Record the clock and timestamp precision explicitly: GitHub Actions timestamps
are normally provider wall-clock observations with one-second precision, while
an in-process span may also carry a monotonic duration with millisecond or
better precision.

The `buildchain.candidate-timeline/v1` artifact reports an independent critical
path for every attempt. Its critical-path duration is the attempt's observed
wall-clock envelope; its active duration and per-phase durations are interval
unions. This prevents nested or parallel spans from being added twice, and it
does not combine a failed or dequeued attempt with a later retry. Missing
required measurements make that attempt `incomplete` instead of producing fake
precision.

Each attempt also reports measured execution lanes, lane skew, cache outcome
counts, the ten longest actionable spans, and one falsifiable next optimization
target. Queue residence, whole-workflow envelopes, and job parents are excluded
from the actionable ranking so they cannot hide the build or qualification
stage that can actually be changed. The target is an observation, not a causal
claim: repeat the same source-bound cohort and disprove it by reducing that span
below the next measured span without increasing attempt elapsed time or
failures.

Shell and workflow consumers can generate the same machine artifact plus a
compact report:

```sh
buildchain candidate timeline \
  --input .buildchain/candidate-timeline-input.json \
  --output .buildchain/candidate-timeline.json
```

The input and output should contain only bounded correlation facts and timing
receipts. Do not include tokens, environment dumps, full commands, raw process
dumps, or private absolute paths.

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
present. If a ccache build does not support JSON stats, Buildchain falls back to
plain `ccache --show-stats` and parses the text counters. Missing cache tools
are recorded as unavailable instead of failing the diagnostics artifact. Call
`collectCompilerCacheDiagnostics()` directly when a consumer script only needs
compiler cache data. Native diagnostics also expose `compilerCaches` and
`nativeCacheDirs` as top-level fields in each diagnostics artifact and aggregate
summary, so reviewers do not have to dig through nested cache sections first.
For reusable builds, sccache outcomes enter structured current-run evidence only
when a sibling `compiler-cache-preparation.json` proves the counters were reset
after install and before build; cumulative stats without that receipt remain
explicitly unavailable.

Process samples are intentionally summarized before they become long-lived
artifacts. The summary records requested parallelism, the source of that value
(`command`, `process-tree`, `env:MAKEFLAGS`,
`env:CMAKE_BUILD_PARALLEL_LEVEL`, or `explicit`), observed active process
concurrency, elapsed sample time, total sampled CPU, and conservative command
categories such as `compiler`, `archive`, `linker`, `build-tool`, and `cache`.
The sampler detects common `make -j N`, `ninja -j N`, CMake/MSBuild/Xcode job
flags, and MAKEFLAGS. This lets native projects distinguish "we asked for
`make -j20`" from "the build graph only kept two active compiler or archive
children busy during the sampled window" without storing environment dumps.

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

In an actual publish job, make that check source-lock aware:

```js
const publishReady = validateAnchoredPackageRelease({
  cwd: process.cwd(),
  requirePublishGateSourceLock: true,
});
```

The source-lock inputs are read from `BUILDCHAIN_PUBLISH_SOURCE_REF`,
`BUILDCHAIN_PUBLISH_SOURCE_SHA`, and `BUILDCHAIN_PUBLISH_SOURCE_LOCKED`, which
the reusable build workflow emits after resolving `publish-source-ref`. That
turns direct channel-branch publication from `alpha/*` or `release/*` into a
hard failure, while `publish-gate/alpha/<line>/<version>` and
`publish-gate/release/<line>/<version>` also validate the requested consumer
version against configured version files and the anchor manifest.

`buildchain lifecycle run` writes this small diagnostics artifact next to the
platform manifest by default. The per-platform diagnostics upload includes the
compact `diagnostics.json`, `diagnostics-manifest.json`, lifecycle
`events.jsonl`, and, when process sampling is enabled, copied
`process-summary.json` and `process-samples.jsonl` sidecars. The sidecar
manifest records each uploaded diagnostics file with its relative path, byte
count, and sha256 hash. It is intended to stay small enough to download without
fetching large binary packages, and it should not include full environment dumps
or secret-looking values.

Use `summarizeDiagnosticsArtifacts()` when a matrix build uploads one
diagnostics artifact per platform. The summary keeps each platform's lifecycle
stage table, adds a lifecycle total duration, carries the top slow spans, and
aggregates warning/error counts plus the slowest platforms. Per-platform rows
also include compact runner facts, checked tool versions/missing tools, package
manager/cache directory details, compiler cache availability, and a compact
process sampler view with requested parallelism, observed max active processes,
the ratio between them, sample count, process categories, and top sampled
command basenames. That gives release reviewers a small cross-platform timing,
runner, tool, cache, and concurrency view without downloading full build outputs
or process sidecars.

The reusable build workflow writes that rollup as `diagnostics-summary.json` and
uploads it in a separate aggregate diagnostics summary artifact. Consumers can
read the `build-diagnostics-summary-artifact` output when they need only timing,
warning/error, runner, cache, and process-sampler context instead of the build
summary or binary artifacts. Per-platform rows keep the diagnostics `links`
object, including the binary artifact name, manifest artifact name, diagnostics
artifact name, platform id, diagnostics sidecar manifest path, manifest path,
summary path, and process sidecar paths when present. They also keep compact
runner/tool/cache summaries so reviewers can tell whether a slow row ran on the
expected runner, missed an expected tool, or lacked useful compiler-cache stats.
When the downloaded platform diagnostics include a sibling
`diagnostics-manifest.json`, `summarizeDiagnosticsArtifacts()` carries a compact
`diagnosticsManifest` section for that platform and verifies the manifest's
`diagnostics.json` byte count and sha256. Missing or mismatched sidecar manifests
increment `diagnosticsManifestWarningCount`, so reviewers can distinguish
diagnostics sidecar drift from lifecycle warnings or build failures.
The same summary carries `diagnosticsContract` per platform and aggregates
`diagnosticsContractWarningCount` when a downloaded `diagnostics.json` does not
match `BUILDCHAIN_DIAGNOSTICS_CONTRACT`.

The diagnostics SDK also exports stable contract constants such as
`BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT`,
`BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT`,
`BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT`,
`BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT`, and
`BUILDCHAIN_ANCHORED_PACKAGE_RELEASE_VALIDATION_CONTRACT` from
`@kungfu-tech/buildchain/diagnostics`; consumers should compare against those
constants instead of hardcoding contract strings.

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

The JSONL sample file stores timestamped process-tree snapshots with full
redacted command lines, command basenames, CPU percentages when available,
elapsed time, and requested parallelism context. Unix and macOS snapshots read
the full `ps args` field instead of truncated `comm` names. Windows snapshots
read `Win32_Process` command lines through PowerShell so the sampler no longer
returns an empty process set on Windows runners. The summary file records
observed concurrency, total sampled CPU, command categories, and top command
basenames. This is intended for diagnosing low-utilization tails such as
archive/link phases without logging full environment dumps.

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

Buildchain also records local control-plane outcome events for workflow-friction
incident handling and production release-intent PR handling. `log summary`
reports the observed incident reuse rate, release-intent suppression rate, and
suppression reasons. A reused incident means an equivalent occurrence found the
same fingerprint and was commented, cooled down, or otherwise reused; a
suppressed release intent means Buildchain proved that the source commit already
had a qualifying merged release PR. These are operational facts, not release
policy inputs, and logging failure remains non-fatal by default.

The reusable promotion workflow uploads `.buildchain/logs/events.jsonl` when a
friction report is produced. The web-surface production release PR handoff
artifact includes the same path, so a real run can falsify the P0 claim instead
of relying only on unit tests.

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
