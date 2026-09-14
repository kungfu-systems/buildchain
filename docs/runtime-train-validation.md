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
  invisible_context: not asserted
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

Install the generated `buildchain-recover.yml` on the protected default branch
before retiring the previous delivery controller. Verify its provider workflow
registration before enabling the normal minimal pipeline. A branch-only manual
caller is not an installed recovery entry. During this bounded migration, pause
the normal pipeline before enabling the previous protected delivery controller;
after the installation merge, wait for its runs and Warrant to become terminal,
then pause that controller before recovering the retained attempt.

The installed caller is byte-identical to the generated consumer recovery entry:
it accepts only `attempt` and optional `runtime-ref`, calls the published
`public-ops-recover.yml@v4-alpha`, and preserves the original source and artifacts.
This installation order does not qualify the full self cutover or Stable release.
