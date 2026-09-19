---
status: draft
period: 2026-09-13
theme: minimal-consumer-product-publication
doc_type: architecture-decision-record
source_level: local-files
confidence: medium
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-19
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-19
  visible_context: Product contract, hosted pipeline, npm provider documentation, publication readback and local failure-path tests.
  invisible_context_boundary: No published entry qualification, production publication or external consumer adoption is established by this document.
---

# ADR 0008: Product publication stays inside the business attempt

The normal pipeline reads the existing schema-2 TOML and derives every declared
product/platform/artifact and publication target. npm packages, native archives
and Paper PDFs use the same entry and product build/verify boundary. Consumers
do not supply standard packaging, signing, publication or recovery commands.

Binary products may also declare `kind = "installer"` for `.dmg`, `.exe`, or
`.AppImage` files. The declaration admits only matching macOS, Windows, or Linux
platforms. The publisher preserves the original installer bytes and download
filename. Bounded header inspection runs without executing or mounting the
installer; truncated headers and mismatched formats are rejected. This format
check does not establish installation success, native code signing or Apple
notarization. The existing GitHub attestation remains a distinct proof. Native
signing integration must be qualified separately before a consumer that requires
it can switch publication pipelines.

The existing macOS credential result admission also binds the runtime and
unsigned transport to the accepted application/DMG notarization evidence. Every
required code-signature, hardened-runtime, stapling and Gatekeeper check must
pass. Both final containers and the selected payload must match the provider
evidence in name, size and digest; a rewritten file manifest cannot substitute
different payload bytes. These checks supplement trusted producer admission;
a self-authored JSON receipt alone never grants signing authority.

macOS binary products can declare required `signing` rules. Each rule names its
primary archive, `profile = "apple-developer-id"`, and either `kind = "archive"`
or `kind = "app-bundle"`. Archive rules can request `jit-executable-v1` for an
explicit list of executable paths. App rules also declare the source `.app`
path, expected `bundle_id`, and a declared DMG `installer` artifact. The primary
app archive is a ZIP. Rules cannot supply credentials, disable signing, share
one output writer, or substitute detached signatures. Windows and Linux installer
format admission does not imply a native signing rule for those platforms.

Native plans, product manifests and qualifications use version 2 contracts.
Unsigned contracts retain their version 1 bytes. The version fence prevents an
older runtime from silently publishing a product while ignoring required native
evidence. The credentialless build seals exact request and transport bytes in its
ordinary immutable product artifact. A separate controller re-reads the original
build jobs and artifact digest before dispatching the existing central signing
authority. It binds the public entry commit separately from the selected signing
runtime, then independently verifies every required signing job and result.
`BUILDCHAIN_AUTOMATION_TOKEN` needs the existing central authority dispatch and
readback access; it never reaches product commands or contains Apple credentials.
Apple secrets remain in the central signing environment.

Dispatch intent is journaled before the provider mutation. An ambiguous response
or timeout retains that operation and its discovered run coordinates. Recovery
observes the same run rather than repeating the dispatch. Absence after an
unknown outcome remains unresolved; it is not permission to create a second
credential execution. Result transport is retained and read back byte for byte.

The separate `Finalize publication` job restores unsigned products and verified
signed outputs, exposes the immutable result index under
`.buildchain/native-signing/<platform>/index.json`, and runs the signed products'
declared `install` and `finalize` commands in the filtered product environment.
Finalization may update declared product metadata but must preserve every signed
archive and installer byte. It cannot reseal signed outputs as unsigned inputs.
Qualification independently re-reads the unsigned producer, central authority
and finalizer before joining their exact manifests into the publication proof.
The GitHub attestation covers this native lineage as well as the final products.

Durable product retention includes the finalization evidence. Once qualified,
recovery restores those exact bytes and re-observes the original authority and
finalizer jobs even if temporary transport artifacts have expired. An unsigned
native build cannot be reused across a signing runtime repair: that platform
rebuilds and creates a new request bound to the repaired runtime. Already
qualified signed bytes keep their original signer and explicit recovery lineage.
Local fixture tests do not establish actual Apple notarization or qualify a
published consumer entry; those still require hosted execution evidence.

Artifact filenames may use the two closed placeholders `{version}` and
`{platform}`. The runtime resolves the selected publication version, including
stable promotion from an Alpha source, before binding the final output inventory
to the Rust-owned publication intent. Unknown expressions, unsafe names, names
over 255 characters and collisions after expansion are rejected. Product paths
remain ordinary declared paths; filename expansion never executes a command or
reads an environment variable. This preserves versioned installer download names
without repository-side publication automation.
Versioned outputs also retain the declaration root before version expansion, so
Stable qualification compares the same filename policy without requiring an
Alpha filename to equal the newly materialized Stable filename.

Each product may declare `timeout_minutes` from 1 through 360 as its required
platform-job budget. Products share one job on a platform, so that job uses the
largest explicitly declared budget among its products. With no declaration,
the existing 60-minute default and matrix identity remain unchanged. Ordinary
builds, publication builds and version preparation use the same admitted matrix;
this setting does not grant credentials, change runners or skip verification.

After exact protected integration, the internal product component reserves one
provider execution in the existing attempt journal. Its repository concurrency
group serializes publication effects. Product commands run on separate hosted
jobs with read-only checkout credentials and a credential-filtered subprocess
environment. Qualification independently reads every completed platform job,
artifact coordinate, manifest and actual payload. Missing platforms, redirected
npm provider configuration and conflicting bytes are rejected.

The plan binds the protected merge source, the original channel PR source, the
selected runtime commit/tree and the defining publisher workflow SHA separately.
Stable version materialization changes only declared version fields in an
isolated Git ref. Its actual commit/tree and original protected source remain in
the Passport; this is not a tree-equivalence claim. The Rust release domain admits
the exact canonical product `apply` job and retains QUALIFY/APPLY/SETTLE ownership.

When a preceding floating channel already names a version overlay, a new overlay
retains that exact observed commit as a second Git parent. Its first parent is
the current protected source, and independent tree comparison still permits only
the declared version-file changes. This explicit merge ancestry preserves the
previous release while allowing a provider-enforced fast-forward of the channel.

The signer attests the complete qualified-product manifest with a predicate that
binds both product sources, runtime, publisher and provider execution. The
publisher verifies the GitHub/Sigstore bundle independently with the actual
defining workflow SHA and provider run source SHA. A custom predicate carries the
distinct materialized product source. This keyless signature is not an
Authenticode or macOS application signature. npm's automatic provenance is
disabled for this sealed publication path because its default workflow source
would describe the controller checkout as the product build source. The retained
custom attestation is published with the qualification and Capsule documents.

Sealed payloads and signing bundles are retained in the existing immutable
material archive before publication. Each provider operation records its intent
before effects and retains exact successful readback before moving on. npm uses
the sealed tarball, ignores lifecycle scripts and requires the registry integrity
to match. GitHub assets and exact tags are never replaced. A lost response is
reconciled from current provider state; completed packages are not republished.
The npm publish command sets `alpha` for prereleases or `latest` for stable
releases directly. There is no temporary npm tag or subsequent npm channel
mutation. A partially completed multi-provider release resumes its missing
effects without repeating an already published package.
The Release contains product assets requested by TOML, its Passport, qualification,
Capsule aggregate, invocation and attestation bundle.

An accepted npm publication can remain unavailable while the registry scans it.
The publisher permits fifteen minutes of bounded readback delays after a
successful publish, retaining the writer fence before every observation. It
never repeats the publish command while waiting. A conflicting integrity fails
immediately; an unavailable version keeps its pending receipt for normal attempt
recovery. This accounts for npm's documented
[publish-time scanning delay](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

Publication success does not finish the business attempt. Distribution moves
only the major Git channel, with exact prior readback and no forced Git update.
It neither queries nor modifies npm for new publications. Divergent Git channel history stops for
source reconciliation. Alpha then prepares the next development version through
an ordinary protected PR. Its original publication and receipts remain successful
while that PR waits for review, queue integration or verification. Anchored
projects wait for a protected change to their declared version authority; the
pipeline does not invent an upstream anchor. Stable publication prepares the next
patch at Alpha zero from the current protected development source. A late
completion observes already advanced development through exact protected PR
proof and cannot regress its version. Stable and Alpha retain their distinct
transition identities and the original successful publication.

Provider authorization is a one-time repository setup. Hosted npm trusted
publishing authorizes package publication together with its final dist-tag; no
npm distribution credential is required. `BUILDCHAIN_NPM_TOKEN` remains optional
for consumers using token-based publication or restricted-package readback.
Internal PR creation uses the repository's automation App
(`BUILDCHAIN_APP_CLIENT_ID` variable and `BUILDCHAIN_APP_PRIVATE_KEY` secret), or
`BUILDCHAIN_AUTOMATION_TOKEN`. It does not use `GITHUB_TOKEN` to create a PR whose
ordinary checks would be suppressed. No such credential reaches product commands.
Review and branch protections still apply to generated PRs.

The earlier two-step npm design left immutable publication and distribution
receipts. Recovery preserves those exact effect identities. Historical channel
effects are read-only: an already published version with a missing channel needs
a one-time authenticated tag correction, after which ordinary attempt recovery
can finish without changing package bytes or retaining a CI write token. New
publications never create those historical channel effects.

The local tests cover real npm packing, native archives and PDFs, source and
version drift, independent provider inventory, signature-verifier rejection,
immutable retention, lost provider responses and protected next-development
waiting/settlement. Hosted publication and the published floating consumer entry
require separate execution evidence; passing these tests alone does not qualify
that distribution boundary.

Restricted npm products require the configured package read credential for provider
readback; anonymous 404 responses cannot qualify private-package absence. This
credential is confined to the fixed npm registry and is not supplied to product
commands. npm OIDC publication does not imply private-package read authority
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).
