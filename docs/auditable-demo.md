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
last_reviewed: 2026-07-28
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-25
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

## Authority Boundary

The retained build output is authoritative. The adapter reads that exact
artifact and projects three files:

```text
complete-transcript.txt
public-projection.json
scene.json
```

The adapter must not rebuild or rerun the product. It receives:

```text
--artifact-root PATH
--output PATH
--source-coordinate PATH
```

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
  projection schemas, out-of-range transcript references, and oversized input;
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

## Media Qualification Profiles

The single machine-readable source is
`contracts/auditable-demo-media-profiles-v1.json`. Callers select one reviewed
profile through `media-profile`; they cannot pass ffmpeg commands, codec flags,
shell fragments, arbitrary profile paths, or transcoding instructions.

| Profile | Meaning |
| --- | --- |
| `archive-v1` | Default compatibility contract. Retains the exact renderer outputs and classifies GIF as README compatibility evidence without making a browser-delivery claim. |
| `web-delivery-v1` | Independently qualifies H.264 MP4 and VP9 WebM playback sources, forbids audio, requires exact scene dimensions and bounded duration/frame-rate drift, checks per-rendition byte ceilings, and proves MP4 `moov` precedes `mdat`. PNG remains the lossless evidence poster. |
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
content-addressed rendition list and explicit roles and MIME types. Agents and
site builds select `primary-video`,
`alternate-video`, `browser-poster`, or evidence-only roles from that receipt;
they do not infer semantics from extensions or filenames. Additional responsive
renditions are accepted only when the immutable renderer manifest declares the
bounded `build-images.auditable-demo-web-delivery/v1` role and MIME metadata and
the selected Buildchain profile supplies the byte ceiling; producer metadata
cannot raise that ceiling. Unbound outputs,
duplicate singleton roles, unknown profiles, or unsupported required versions
fail closed.

Initial byte ceilings are derived from the checked-in
`auditable-demo-web-delivery-v1` fixture rendered by Build Images
`v1.3.0-alpha.16` at its exact source SHA and image digest. GIF, MP4, WebM, and
PNG ceilings are the next power of two above sixteen times the measured member
bytes. The not-yet-produced WebP poster uses eight times the measured lossless
PNG as its conservative proxy. The path-scoped qualification workflow
regenerates the content-addressed evidence and fails on any byte or fact drift.

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
      renderer-image: ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:RENDERER_DIGEST
      render-media: false
      media-profile: archive-v1
```

Replace both placeholders with reviewed immutable SHAs or digests. An eligible
build should always call the reusable workflow. Selection policy changes only
`render-media`; it must never condition away the Gate job.

Use `web-delivery-v1` only when the rendered bundle is intended to become a
qualified web-delivery source. Use `site-hero-v1` when an optimized browser
poster is also required. Profile qualification does not prove browser playback,
responsive layout, reduced-motion behavior, accessibility, or production
deployment; those remain site responsibilities.

## Failure Evidence

Gate and render jobs use bounded timeouts and non-cancelling concurrency.
Diagnostics artifacts are attempted with `always()` so adapter stdout/stderr
and the resolved source coordinate remain available when qualification fails.
No production deployment, publication authority, token, or provider mutation
is part of this workflow.
