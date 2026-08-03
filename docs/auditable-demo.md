---
status: draft
period: 2026-07
theme: auditable-demo-pipeline
doc_type: technical-contract
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-02
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-02
  invisible_context_boundary: No hidden model build, parameter count, or private corpus is asserted.
---

# Auditable Demo Pipeline

Buildchain's auditable demo workflow turns an exact GitHub build artifact into
two distinct evidence products:

1. a required qualified Gate bundle; and
2. an optional rendered media bundle that can exist only after that exact Gate
   bundle passes.

The public reusable workflow is
`.github/workflows/.auditable-demo.yml`. It is consumer-neutral: Buildchain
does not know how a Kungfu, library, service, or application artifact should be
interpreted. The consumer owns a small checked-in executable adapter.

For standalone binary CLIs, the higher-level first-class surface is
`.github/workflows/.declarative-auditable-demo.yml`. A consumer checks in only
`.buildchain/auditable-demo.json`, builds and uploads its exact same-run binary
plus metadata, and passes the producer-owned artifact name and digest to that
workflow. Buildchain then owns capture, Gate adaptation, independent native
1080p and 720p rendering, Release Passport construction, content-addressed
materialization, and the protected README update pull request. No
product-specific capture, adapter, passport, or materializer is required.

## Declarative Standalone Binary Scenarios

The schema is `contracts/auditable-demo-scenario-v1.schema.json`. One scenario
can declare up to eight demos, and each demo can contain up to twelve ordered
literal argv steps. Steps in one demo share a disposable workspace; separate
demos and the two rendition captures do not. Commands are never accepted as a
shell string. An omitted or explicit `standard` duration class remains bounded
to 60 seconds. A reviewed `execution.durationClass: long-form` declaration may
raise the scenario and literal step ceilings to 180 seconds; it does not change
the default. Both classes retain 4 MiB per step, a clean Home/XDG environment,
no inherited credentials, and a network-disabled read-only container with
bounded tmpfs.

The uploaded metadata must bind the executable SHA-256, declare an empty
runtime dependency set, and provide a bounded `executableFiles` array of exact
artifact-relative paths and SHA-256 digests. GitHub Artifact transport does not
retain Unix executable modes, so Buildchain restores mode `0755` only for this
digest-verified executable closure and verifies the same closure again inside
the network-disabled capture boundary. It never recursively changes artifact
modes. This metadata controls assembly only and grants no execution,
publication, or identity authority. Capture rejects an artifact name or upload
digest that does not resolve to exactly one live artifact from the current workflow run.

Consumers may also declare one bounded, non-interactive `transportSmoke` argv
in the same scenario and opt the reusable build into
`pre-upload-transport-smoke-scenario-path`. Before any GitHub Artifact or S3
relay upload, Buildchain copies the exact distribution directory, removes Unix
execute bits to simulate transport, restores only the digest-bound executable
closure, and runs that real binary with a clean Home/XDG environment. A missing
launcher, runtime, or embedded interpreter therefore fails before the expensive
upload begins. This is a transport diagnostic with no authority grants; the
later network-disabled capture and Gate remain the qualification authority.
It retains ANSI terminal bytes with the real PTY read timestamps, verifies
declared stdout and JSON file facts, enforces the total deadline while a step is
running, and removes the disposable workspace before emitting evidence.

Both manual validation and alpha or release refreshes call the same reusable
workflow. Manual callers select Gate-only or full rendering and can explicitly
request a materialization PR. Release callers select full rendering and the
same materializer automatically; there is no separate release-only recording
implementation. Publication requires a dedicated update token and target
branch. The token is an explicit bounded capability, while actor identity,
first-party/System classification, KFD compliance, Product System metadata,
package metadata, registry history, scans, and generated evidence grant no
authority.

```yaml
jobs:
  demo:
    needs: exact-binary
    uses: kungfu-systems/buildchain/.github/workflows/.declarative-auditable-demo.yml@BUILDCHAIN_EXACT_SHA
    with:
      source-ref: ${{ github.sha }}
      binary-artifact-name: ${{ needs.exact-binary.outputs.artifact-name }}
      binary-artifact-digest: ${{ needs.exact-binary.outputs.artifact-digest }}
      scenario-path: .buildchain/auditable-demo.json
      renderer-image: ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:RENDERER_DIGEST
      render-media: true
      media-profile: responsive-web-delivery-v1
      materialize: true
      materialize-base-ref: dev/v1/v1.0
    secrets:
      DEMO_UPDATE_TOKEN: ${{ secrets.DEMO_UPDATE_TOKEN }}
```

Buildchain recursively consumes this surface in
`.github/workflows/auditable-demo.yml` using its own exact standalone binary
and the beginner bootstrap scenario in `.buildchain/auditable-demo.json`.

## Authority Boundary

The retained build output is authoritative. The adapter reads that exact
artifact and projects three files:

```text
complete-transcript.txt
public-projection.json
scene.json
```

It may additionally emit one declared `terminal-capture.json` using
`kungfu.terminal-capture/v1`. The optional capture is bounded to 60 seconds by
default or 180 seconds only when its scene explicitly declares `long-form`,
fixed 80-200 by 24-80 terminal cells, 10,000 events, and 4 MiB of canonical
base64 bytes. It must contain a qualified completion sentinel and an explicitly
empty authority-grant list. Existing three-file adapters remain valid.

The completion sentinel names a consumer-owned versioned schema, the exact
`qualified` status, a content root, and an event count. Buildchain validates
that envelope generically; it does not reinterpret a command-specific result
as Agent Work Lab evidence or grant authority from the schema name. The
consumer projection and its retained source artifact remain responsible for
the exact claim boundary.

Terminal bytes are volatile observations, not Work, Warrant, capability, or
publication authority. First-party or System identity, KFD compliance, Product
System metadata, package metadata, scan output, registry history, and
standalone generation remain non-authoritative unless an exact higher-level
contract independently admits them.

The adapter must not rebuild or rerun the product. It receives:

```text
--artifact-root PATH
--output PATH
--source-coordinate PATH
```

Consumers with one shared adapter for several deterministic demos may also set
`adapter-arguments-json` to a bounded JSON array. Buildchain parses the array,
rejects malformed values, newlines, NUL bytes, more than 32 arguments, values
longer than 256 bytes, and attempts to override the three coordinate flags
above, then appends the accepted strings directly to the adapter argv. It never
evaluates a shell command. The exact argument vector and its content root are
retained in `adapter.json`; the Gate receipt binds that root. Adapter arguments
select consumer-owned capture behavior only and grant no authority.

`--source-coordinate` identifies the caller repository, run, artifact id,
artifact name, upload digest, expiry, and exact source SHA. The workflow finds
exactly one live artifact with the requested name in the current caller run and
rejects a digest mismatch before invoking the adapter. Callers must pass the
digest emitted by their own `upload-artifact` step; a name resolved later from
the Actions API is discovery evidence, not a substitute for that producer
output.

Buildchain's reusable build workflow exposes `artifact-coordinates-json` after
all resolved platform uploads complete. That producer-owned output binds every
platform id to its same-run artifact id, name, upload digest, URL, and expiry,
so a consumer that delegates its build to Buildchain can pass an exact
coordinate without rediscovering authority in a downstream job. The build
aggregate fails closed if any declared platform lacks one live, digest-bearing
artifact coordinate. The compact coordinate set is sorted by platform id so
downstream machine consumers do not depend on matrix completion order.

The adapter runs with a disposable Home/XDG/npm prefix, a minimal environment,
and no GitHub, npm, or cloud credential injection. It must be a regular,
non-symlink, executable file inside the exact checked-out consumer source.

## Required Gate

The Gate:

- checks out the exact consumer source and exact called-workflow SHA;
- resolves and downloads one exact same-run GitHub Artifact;
- invokes the checked-in adapter by argv, never as an evaluated shell string;
- rejects undeclared adapter outputs, symlinks, invalid UTF-8, invalid scene or
  projection or terminal-capture schemas, implicit capture grants,
  out-of-range transcript references, and oversized input;
- derives a one-second compatibility scene from the consumer projection;
- anonymously pulls an immutable `image@sha256:digest` renderer;
- runs it as non-root with `--network none`, a read-only root filesystem, and a
  bounded tmpfs;
- verifies the renderer manifest, media probe, exact input roots, exact output
  member set, and complete checksums;
- uploads a content-addressed qualified bundle plus an independent GitHub
  Artifact id, URL, archive digest, and expiry-bearing source coordinate.

The Gate bundle contains the complete consumer transcript/projection/scene,
source artifact coordinate, adapter identity, bounded renderer evidence, a
passed gate receipt, and checksums covering every member exactly once.

## Selective Render

`render-media: true` enables the second job. It downloads the just-uploaded Gate
bundle by its content-addressed name, recomputes the Gate member root, verifies
the exact source SHA and renderer digest, and only then renders the complete
qualified scene.

The media bundle contains MP4, WebM, GIF, poster, probe, renderer manifest,
renderer checksums, passed Gate receipt, a versioned media receipt, and
distribution checksums. A web-delivery profile also retains
`media-inspection.json`, whose content root is bound into the receipt.
`render-media: false` does not weaken or skip the Gate.

When the Gate bundle contains a qualified terminal capture, the render job
passes it read-only to the immutable renderer. The renderer manifest binds the
capture root and terminal-state-machine version, but raw capture bytes remain
in the Gate bundle rather than being copied into the public media bundle.

## Media Qualification Profiles

The single machine-readable source is
`contracts/auditable-demo-media-profiles-v1.json`. Callers select one reviewed
profile through `media-profile`; they cannot pass ffmpeg commands, codec flags,
shell fragments, arbitrary profile paths, or transcoding instructions.

| Profile | Meaning |
| --- | --- |
| `archive-v1` | Default compatibility contract. Retains the exact renderer outputs and classifies GIF as README compatibility evidence without making a browser-delivery claim. |
| `web-delivery-v1` | Independently qualifies H.264 MP4 and VP9 WebM playback sources, forbids audio, requires exact scene dimensions and bounded duration/frame-rate drift, checks per-rendition byte ceilings, and proves MP4 `moov` precedes `mdat`. PNG remains the lossless evidence poster. |
| `responsive-web-delivery-v1` | Extends `web-delivery-v1` with exact 1280x720 H.264 MP4 and VP9 WebM responsive sources plus a 1280x720 README GIF while keeping the primary MP4/WebM and evidence poster at the source scene dimensions. Every declared downscale must preserve the scene aspect ratio and may never upscale. |
| `responsive-long-form-web-delivery-v1` | Extends the responsive profile for explicitly admitted long-form scenes. Its measured-baseline multipliers raise only the GIF ceiling to 8 MiB and the four video ceilings to 4 MiB; all codec, native-resolution, no-audio, duration, and authority checks remain unchanged. |
| `site-hero-v1` | Extends `web-delivery-v1` and additionally requires a qualified WebP browser poster. The current Build Images v1 renderer does not emit that member, so selecting this profile fails closed until the producer adds it. |

For web-delivery profiles, Buildchain runs its own fixed `ffprobe` invocation
inside the same immutable, network-disabled renderer image. That command is
Buildchain-controlled; the producer cannot inject flags. The resulting witness
records exact roots and byte counts plus container, codec, pixel format,
dimensions, duration, frame rate, audio stream count, and progressive-download
evidence. Finalization re-hashes the retained bytes, rechecks the witness root,
and parses MP4 top-level boxes itself. The producer's `media-probe.json.passed`
field remains supporting evidence, never sufficient authority.

The default `archive-v1` path preserves the existing v1 media receipt exactly.
An explicitly selected web-delivery profile emits a v2 media receipt with a
content-addressed rendition list and explicit roles, MIME types, dimensions,
and dimension policy. Agents and site builds select `primary-video`,
`alternate-video`, `responsive-primary-video`,
`responsive-alternate-video`, `browser-poster`, or evidence-only roles from
that receipt; they do not infer semantics from extensions or filenames.
Profile-declared responsive renditions must match their exact dimensions,
remain within the source scene, and preserve its aspect ratio. Additional
producer-declared renditions remain bounded by the selected profile and cannot
raise their own byte ceiling. Unbound outputs, implicit upscales, aspect-ratio
drift, duplicate singleton roles, unknown profiles, or unsupported required
versions fail closed.

The required Gate binds the exact selected media profile and the smoke media
qualification root before optional full rendering starts. Gate-only validation
and full rendering therefore exercise the same profile contract; a later media
job cannot silently switch rendition authority.

Initial byte ceilings are derived from the checked-in
`auditable-demo-web-delivery-v1` fixture rendered by Build Images
`v1.3.0-alpha.16` at its exact source SHA and image digest. GIF, MP4, WebM, and
PNG ceilings are the next power of two above sixteen times the measured member
bytes. The explicit responsive long-form profile derives its 4 MiB video and
8 MiB GIF ceilings from the same observed bytes at a bounded 128-times
multiplier; it does not change another profile. The not-yet-produced WebP poster
uses eight times the measured lossless PNG as its conservative proxy. The path-scoped qualification workflow
regenerates the content-addressed evidence and fails on any byte or fact drift.
Its matrix retains the original 1280x720 web-delivery baseline on the renderer
that produced it and separately measures the responsive profile against a
1920x1080 fixture and the first exact renderer release that emits both
source-resolution and 720p renditions. This keeps historical budget evidence
reproducible while giving the responsive contract its own immutable
qualification root.

## Consumer Example

The build job must expose both the exact artifact name and the digest returned
by `upload-artifact`:

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    outputs:
      artifact-name: product-linux-${{ github.sha }}
      artifact-digest: ${{ steps.upload.outputs.artifact-digest }}
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
      - run: ./scripts/build-product
      - id: upload
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: product-linux-${{ github.sha }}
          path: dist
          if-no-files-found: error
          retention-days: 14
          compression-level: 0

  auditable-demo:
    needs: build
    permissions:
      actions: read
      contents: read
    uses: kungfu-systems/buildchain/.github/workflows/.auditable-demo.yml@BUILDCHAIN_EXACT_SHA
    with:
      source-ref: ${{ github.sha }}
      source-artifact-name: ${{ needs.build.outputs.artifact-name }}
      source-artifact-digest: ${{ needs.build.outputs.artifact-digest }}
      adapter-path: scripts/auditable-demo-adapter
      adapter-arguments-json: '["--demo-id","agent-work-lab"]'
      renderer-image: ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:RENDERER_DIGEST
      render-media: false
      media-profile: archive-v1
```

Replace both placeholders with reviewed immutable SHAs or digests. An eligible
build should always call the reusable workflow. Selection policy changes only
`render-media`; it must never condition away the Gate job.

Use `web-delivery-v1` only when the rendered bundle is intended to become a
qualified web-delivery source. Use `site-hero-v1` when an optimized browser
poster is also required. Select `responsive-long-form-web-delivery-v1` only
with an explicit long-form scenario. Profile qualification does not prove browser playback,
responsive layout, reduced-motion behavior, accessibility, or production
deployment; those remain site responsibilities.

## Failure Evidence

Gate and render jobs use bounded timeouts and non-cancelling concurrency.
Diagnostics artifacts are attempted with `always()` so adapter stdout/stderr
and the resolved source coordinate remain available when qualification fails.
No production deployment, publication authority, token, or provider mutation
is part of this workflow.
