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
last_reviewed: 2026-09-08
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-08
  invisible_context: not asserted
---

# Runtime Train Validation

A train repairs the execution runtime without changing the consumer's durable
public entry. All public workflows, including ordinary builds, use the same
[Runtime entry contract](runtime-entry.md). The transient runtime parameter
wins over the consumer lock. Buildchain dogfood follows this same path.

## Validate a runtime change

1. Commit the candidate with its action bundles, WASM and runtime contract.
2. Publish the candidate at `train/v4/v4.1/<capability>`.
3. Dispatch the consumer's existing public entry with `runtime-ref` set to that
   train. Record the selected runtime, consumer source and resulting evidence.
4. After checks and independent review, merge into protected Dev and publish
   the requested Alpha. Qualify the published entry before Stable promotion.

Train selection is a trusted non-persistent runtime input. It never grants
publication or signing authority by itself; those business effects retain their
provider credentials, capability constraints and readback requirements.

## Recover a runtime failure

Start a new dispatch through the same public entry with the repaired train.
For builds, supply `resume-run-id`; for release promotion, preserve the original
candidate run and transaction in the typed request. The entry prepares runtime
Y while the task keeps its original source and valid completed evidence.
A GitHub failed-job rerun does not change its inputs and cannot select a new
runtime. Do not persist the train into the caller workflow or contract lock.

If the public entry itself is defective, publish and adopt the corrected entry
and start a full run. Copied consumer recovery packages and alternate recovery
workflows are not part of the runtime contract.
