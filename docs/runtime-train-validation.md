---
status: active
period: ongoing
theme: buildchain-runtime-train-validation
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-14
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-14
  visible_context: Source-bound caller installation, pipeline wake implementation and GitHub event documentation.
  invisible_context_boundary: No unobserved provider execution or publication authority is claimed.
---

# Runtime Train Validation

A train repairs the execution runtime without changing the consumer's durable
public entry. All public workflows, including ordinary builds, use the same
[Runtime entry contract](runtime-entry.md). The recovery entry accepts a transient runtime parameter, which wins over the
consumer lock. The normal minimal pipeline accepts only an optional config path.
Buildchain dogfood follows the same two-entry contract.

## Validate a runtime change

1. Commit the candidate with its action bundles, WASM and runtime contract.
2. Publish the candidate at `train/v4/v4.1/<capability>`.
3. Recover the exact retained attempt through `buildchain-recover.yml`, with
   `runtime-ref` set to that train. Record the attempt, selected runtime, consumer
   source and resulting evidence.
4. After checks and independent review, merge into protected Dev and publish
   the requested Alpha. Qualify the published entry before Stable promotion.

Train selection is a trusted non-persistent runtime input. It never grants
publication or signing authority by itself; those business effects retain their
provider credentials, capability constraints and readback requirements.

## Recover a runtime failure

Start a new dispatch through `buildchain-recover.yml` with the exact attempt
and the repaired train. The runtime selects the retained source and completed
evidence; the consumer does not provide candidate, run or transaction selectors.
A GitHub failed-job rerun does not change its inputs and cannot select a new
runtime. Do not persist the train into the caller workflow or contract lock.

If the public entry itself is defective, publish and adopt the corrected entry
and start a full run. Copied consumer recovery packages and alternate recovery
workflows are not part of the runtime contract.

## Protected minimal-entry installation

Install both generated callers, `buildchain.yml` and `buildchain-recover.yml`,
on the protected default branch before retiring the previous delivery controller.
Read back both files at the exact protected commit and verify their provider
workflow registrations. A workflow registered from a task branch does not prove
that its event receiver is installed on the default branch. GitHub requires that
location for [repository dispatch events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch).

Recovery preserves source and completed artifacts, then emits a repository
wake for the remaining pipeline work. That wake requires the normal caller on
the default branch; installing only the manual recovery caller leaves this
continuation receiver absent. Verify the complete pair before the first recovery.

During this bounded migration, pause the normal pipeline before enabling the
previous protected delivery controller. After the installation merge, wait for
its runs and Warrant to become terminal, then pause that controller and enable
the normal pipeline before recovering a current admitted attempt. An installation
merge advances the protected base, so an older unmerged source attempt must be
re-admitted on the current base before recovery.

Both callers are byte-identical to the generated consumer entries and call the
published `@v4-alpha` public workflows. Recovery accepts only `attempt` and
optional `runtime-ref`; the normal caller retains its protected config path.
This installation order does not qualify the full self cutover or Stable release.
