---
status: draft
period: 2026-09-13
theme: minimal-consumer-version-preparation
doc_type: architecture-decision-record
source_level: local-files
confidence: medium
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-13
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-13
  visible_context: Consumer compiler, prepared self product contract, product execution, version materialization, provider adapters and local adversarial tests.
  invisible_context_boundary: Local tests do not establish published entry qualification, hosted provider authorization or completed self migration.
---

# ADR 0009: Regenerate version data before qualifying the final product source

Changing a package version can invalidate generated documents that embed that
version or hashes of other documents. Both publication and next-development
preparation must regenerate those declared documents before creating the final
Git source. Leaving the old documents in place would fail the ordinary clean
source build, or publish facts that disagree with the product version.

The runtime retains an exact preparation in the current attempt. It binds the
source and TOML, selected runtime, target version, parent plan, purpose and
declared platforms. An internal component checks out that source on separate
product runners, patches only declared primary version fields, and executes the
existing product install/build/verify commands without publication credentials.
No new consumer command or workflow input is needed.

The product result contains every declared version document and derived file.
The source guard compares all original tracked bytes, types, executable modes,
HEAD and tree directly; index flags cannot hide modifications. Only declared
material bytes may change. Primary documents must exactly equal the pure version
field patch. Changed derived documents from different platforms must agree.
The source TOML, managed runtime locks and workflow authority cannot be generated
as version material. Paths are literal, regular UTF-8 files with bounded size;
symlink and submodule sources are not qualified by this preparation implementation.

The ordinary product build also compares every tracked file directly with its
admitted Git blob before and after executing commands. Index flags, local clean
filters and ignored executable-mode changes cannot make altered bytes qualify.
Tracked symbolic links retain their exact target bytes; parent directories
cannot become links. Source checkout transformations must preserve the admitted
bytes (Buildchain declares LF checkout in `.gitattributes`); unresolved submodules
are rejected. This strengthens both the initial version-preparation source check
and ordinary build qualification without granting product commands credentials.

Project Cut replay transfers generated source patches through private temporary
files instead of buffering them as command metadata. Git still applies the exact
binary patch to an isolated index and compares stable patch identity and changed
paths against the source. This permits large committed action bundles without
changing the source composition, family receipt, conflict rejection or metadata
output bound. Temporary descriptors and files are closed on success and failure.

A separate job checks the original published caller, exact reusable definitions,
provider run and retry, every successful platform job, and immutable artifact
digests before reading results. The retained preparation and actual source
contract are checked again before the qualified material enters the journal.
Git materialization verifies the resulting tree, exact document bytes and ref.
The final product build then runs against that exact materialized source and is
qualified and signed through the existing publication boundary.

For next-development, the same preparation starts from the retained current
protected development source. It creates an ordinary PR and preserves the
completed publication while waiting for protected review and integration.
Recovery can reuse retained material only for the same parent and runtime;
conflicting qualified results fail closed. Published payloads and provider
receipts remain immutable under the existing recovery contract.

This adds actual product execution when derived version files are declared.
The publication component calls one shared internal version component for its
two purposes. Each component stays within the existing job, step and module
budgets. Local tests cover real child processes and Git byte guards, artifact
transport rejection, retained request admission, materialization and existing
recovery regressions. Hosted platform and provider qualification remain separate
delivery requirements.

An npm artifact may declare `path = "."` to pack the product directory through
the standard runtime packer with lifecycle hooks disabled. Optional artifact
`filename` data preserves established download names. Names are single bounded
filenames with the declared format, unique across the full publication plan,
and independently verified against the packed file. These fields do not expose
publication commands or provider control to the consumer.

The prepared `.buildchain/minimal-consumer.toml` declares Buildchain's npm
package and the three existing binary downloads using those ordinary product
fields. It retains all seven primary version documents and three derived
documents. The contract is inactive: the current callers still select
`.buildchain/buildchain.toml`. Publishing this preparation does not activate a
second publisher or prove the self migration. The protected transition must
qualify the published entry and selected runtime, preserve the existing stable
qualification gates, retire the old consumer callers with a single writer,
and finally use the shared normal/recovery pair and canonical TOML path.

Each declared native checkpoint platform retains a full candidate action build,
site generation and repository check through ordinary product commands. Linux
runs this with the npm product; macOS and Windows run it with their standalone
product. The full check includes the product's checkpoint clean-process and
recovery tests; a binary version/help smoke test alone cannot replace source
qualification. Rust formatting, lint and WASM toolchain components are explicit
install commands on each platform. Local configuration checks establish this
wiring only; the protected hosted executions and any remaining container-specific
qualification must still pass before retiring the existing verification caller.

Site generation reads its KFD upstream declarations from the product-owned
`architecture/product-upstreams.json`. The existing collector receives this
data explicitly, so changing the consumer TOML to the minimal schema preserves
the product's seven upstream evidence assets and their digests. The legacy
configuration retains its declarations until the protected caller cutover;
the new data contains no build, publication or recovery orchestration.

The prepared contract also declares stable eligibility as a closed `stable`
table: minimum publication interval and canary soak in seconds, literal product
paths, a product impact document, and whether published-entry qualification is
required. It carries no workflow names, provider commands or evidence selectors.
The publication plan retains an independent copy under its immutable root.
The self preparation preserves the existing 86,400-second interval and
3,600-second soak. The shared stable evaluator now rejects impact from another
candidate version and duplicate canary observations instead of selecting the
last observation. These declarations and local checks do not activate the new
publisher: independent provider collection and enforcement in the pipeline
remain required before the protected self cutover.
Stable preparation and application now collect source facts after verifying
the authoritative attempt. The collector resolves the exact public Alpha tag,
requires the same channel PR source and compiled contract, and verifies every
declared version document. It reads product impact from a bounded regular Git
blob in that exact tree, independently checking its bytes and version. Product
differences include added, removed and mode-changed files from complete Git
trees; a short comparison listing cannot silently hide product changes.

Complete bounded release pagination identifies the previous published product
and the most recent earlier stable publication, including backports for the
cooldown. The comparison must match the plan's retained previous channel.
Fresh tag, release and predecessor observations reject concurrent changes.
Same-version recovery does not count its own completed publication as an older
release. These facts carry their own root and the exact publication plan root.

New publication plans declare evidence version 1 and publish their full plan
alongside qualification, capsules, invocation, attestation and Passport. The
plan root is already bound by the signed product predicate. Recovery of an older
retained transaction preserves its original evidence inventory and provider
receipts; it does not retroactively add a plan or replace public bytes.

Stable product qualification reads those fixed evidence assets from the exact
Alpha release, with complete bounded pagination, unique identities, byte digests
and a second asset readback. It checks the original signature through the
central publisher workflow and exact provider source, reconstructs the Passport
and invocation, and requires every declared product/platform output. Original
build jobs and the signing job must still match provider readback, including
their attempt, source, publisher definition and completion times. Historical
qualification is checked at its issue time; it does not renew that receipt or
authorize the current Stable publisher. Successful product evidence also causes
another source observation before the eligibility decision.

Published-entry qualification independently inventories completed normal PR
runs after the exact Alpha release. It verifies the generated thin caller,
published entry definition, managed source lock and selected candidate runtime,
then reads the original native Attempt and retained product-build receipt.
The normal consumer commit can differ from the released runtime commit; its
compiled product contract must be identical. Every declared platform and the
exact recorder job must agree with fresh provider readback. A newer failed or
unrecorded matching build blocks fallback to older successful evidence. Recovery
runs, foreign entries and an old runtime behind a new entry do not qualify.

When only the publication interval or canary soak remains unsatisfied, preparation
retains the eligibility and a source-bound waiting receipt in the same Attempt.
An internal job outside the repository publication lock waits at most fifteen
minutes, checks native ownership every thirty seconds, and wakes the same normal
entry. The next execution recollects qualification; the waiting receipt grants
no publication authority. Publication checks again before provider effects and
can return to this waiting path if new evidence moves the soak deadline.

The timer stops if its retained receipt is superseded, the Attempt changes or
the phase advances. A successor can claim the exact waiting native head while
the old outer run finishes its wake job; the existing worker fence then rejects
the old publisher. Missing qualification and non-time failures remain errors.
Local tests exercise real native records with deterministic provider facts and
an injected clock, including bounded waits and stale-worker races. They do not
establish live published qualification or activate the prepared self contract.
Alpha preparation remains available for the protected transition; the legacy
stable publisher retains its existing policy until the protected self cutover.
