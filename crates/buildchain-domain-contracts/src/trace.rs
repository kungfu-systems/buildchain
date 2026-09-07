use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ContractFault, ContractResult, EventEnvelope, MAX_SAFE_INTEGER, ReceiptEnvelope, ascii_token,
    canonical_bytes, content_root, validate_root,
};

pub const DELIVERY_WARRANT_TRACE_CONTRACT: &str = "buildchain-v4-delivery-warrant-trace-fixture/v1";
pub const DELIVERY_WARRANT_RUNNER_CONTRACT: &str =
    "buildchain-v4-delivery-warrant-fixture-runner/v1";
pub const DELIVERY_WARRANT_PROJECTION_CONTRACT: &str =
    "buildchain-v4-delivery-warrant-semantic-projection/v1";

const FIXTURE_KEYS: &[&str] = &[
    "schemaVersion",
    "contract",
    "runner",
    "trace",
    "expectedProjectionRoot",
];
const TRACE_KEYS: &[&str] = &["id", "kind", "initialState", "initialStateRoot", "steps"];
const STATE_KEYS: &[&str] = &[
    "schema",
    "generation",
    "fencingCounter",
    "activeWarrant",
    "candidates",
];
const STEP_KEYS: &[&str] = &[
    "sequence",
    "id",
    "operation",
    "event",
    "decision",
    "priorStateRoot",
    "successorState",
    "successorRoot",
    "effects",
    "observations",
    "receipt",
    "receiptRoot",
];
const EVENT_KEYS: &[&str] = &[
    "schema",
    "eventId",
    "eventType",
    "occurredAt",
    "subjectRoot",
    "payload",
];
const RECEIPT_KEYS: &[&str] = &[
    "schema",
    "receiptType",
    "recordedAt",
    "eventRoot",
    "priorStateRoot",
    "nextStateRoot",
    "outcome",
    "fault",
];
const FAULT_KEYS: &[&str] = &["schema", "code", "class", "path", "message", "retry"];
const ORDERED_ENTRY_KEYS: &[&str] = &["sequence", "type", "payload"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceFixture {
    schema_version: u64,
    contract: String,
    runner: String,
    trace: Trace,
    expected_projection_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trace {
    id: String,
    kind: String,
    initial_state: Value,
    initial_state_root: String,
    steps: Vec<TraceStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceStep {
    sequence: u64,
    id: String,
    operation: String,
    event: EventEnvelope,
    decision: Decision,
    prior_state_root: String,
    successor_state: Value,
    successor_root: String,
    effects: Vec<OrderedEntry>,
    observations: Vec<OrderedEntry>,
    receipt: ReceiptEnvelope,
    receipt_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    action: Option<String>,
    fault: Option<ContractFault>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderedEntry {
    sequence: u64,
    #[serde(rename = "type")]
    entry_type: String,
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticProjection {
    schema: &'static str,
    trace_id: String,
    trace_kind: String,
    steps: Vec<StepProjection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepProjection {
    sequence: u64,
    id: String,
    operation: String,
    decision: Decision,
    event_root: String,
    successor_canonical_utf8: String,
    successor_root: String,
    generation: u64,
    fencing_counter: u64,
    effects: Vec<EffectProjection>,
    observations: Vec<ObservationProjection>,
    receipt_canonical_utf8: String,
    receipt_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectProjection {
    sequence: u64,
    #[serde(rename = "type")]
    entry_type: String,
    canonical_utf8: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservationProjection {
    sequence: u64,
    #[serde(rename = "type")]
    entry_type: String,
    canonical_utf8: String,
    root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRun {
    pub projection: Value,
    pub projection_root: String,
}

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn exact_keys(value: &Value, keys: &[&str], path: &str) -> ContractResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| fault("invalid-object", path, format!("{path} must be an object")))?;
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = keys.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(fault(
            "invalid-trace-shape",
            path,
            format!("{path} keys are not canonical"),
        ));
    }
    Ok(())
}

fn validate_closed_shape(value: &Value) -> ContractResult<()> {
    exact_keys(value, FIXTURE_KEYS, "$")?;
    let trace = &value["trace"];
    exact_keys(trace, TRACE_KEYS, "$/trace")?;
    exact_keys(&trace["initialState"], STATE_KEYS, "$/trace/initialState")?;
    let steps = trace["steps"].as_array().ok_or_else(|| {
        fault(
            "invalid-trace-shape",
            "$/trace/steps",
            "trace steps must be an array",
        )
    })?;
    for (index, step) in steps.iter().enumerate() {
        let path = format!("$/trace/steps/{index}");
        exact_keys(step, STEP_KEYS, &path)?;
        exact_keys(&step["event"], EVENT_KEYS, &format!("{path}/event"))?;
        exact_keys(
            &step["decision"],
            &["action", "fault"],
            &format!("{path}/decision"),
        )?;
        exact_keys(
            &step["successorState"],
            STATE_KEYS,
            &format!("{path}/successorState"),
        )?;
        exact_keys(&step["receipt"], RECEIPT_KEYS, &format!("{path}/receipt"))?;
        for key in ["effects", "observations"] {
            let entries = step[key].as_array().ok_or_else(|| {
                fault(
                    "invalid-trace-shape",
                    &format!("{path}/{key}"),
                    format!("{path}/{key} must be an array"),
                )
            })?;
            for (entry_index, entry) in entries.iter().enumerate() {
                exact_keys(
                    entry,
                    ORDERED_ENTRY_KEYS,
                    &format!("{path}/{key}/{entry_index}"),
                )?;
            }
        }
        for key in ["decision", "receipt"] {
            let fault_value = &step[key]["fault"];
            if !fault_value.is_null() {
                exact_keys(fault_value, FAULT_KEYS, &format!("{path}/{key}/fault"))?;
            }
        }
    }
    Ok(())
}

fn require_token(value: &str, path: &str) -> ContractResult<()> {
    if !ascii_token(value) {
        return Err(fault(
            "invalid-trace-token",
            path,
            format!("{path} must be an ASCII token"),
        ));
    }
    Ok(())
}

fn declared_root(declared: &str, expected: &str, path: &str, code: &str) -> ContractResult<String> {
    validate_root(declared, path)?;
    if declared != expected {
        return Err(fault(
            code,
            path,
            format!("{path} does not match the retained canonical bytes"),
        ));
    }
    Ok(declared.to_owned())
}

fn canonical_utf8(value: &Value) -> ContractResult<String> {
    String::from_utf8(canonical_bytes(value)?)
        .map_err(|_| fault("invalid-trace-bytes", "$", "canonical bytes are not UTF-8"))
}

fn state_counter(state: &Value, name: &str, path: &str) -> ContractResult<u64> {
    state[name]
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER as u64)
        .ok_or_else(|| {
            fault(
                "invalid-trace-integer",
                &format!("{path}/{name}"),
                format!("{path}/{name} must be a non-negative safe integer"),
            )
        })
}

fn project_entries(entries: &[OrderedEntry], path: &str) -> ContractResult<Vec<EffectProjection>> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if entry.sequence != index as u64 {
                return Err(fault(
                    "reordered-trace",
                    &format!("{path}/{index}/sequence"),
                    format!("{path} sequence must be contiguous and ordered"),
                ));
            }
            require_token(&entry.entry_type, &format!("{path}/{index}/type"))?;
            Ok(EffectProjection {
                sequence: entry.sequence,
                entry_type: entry.entry_type.clone(),
                canonical_utf8: canonical_utf8(&entry.payload)?,
            })
        })
        .collect()
}

fn project_observations(
    entries: &[OrderedEntry],
    path: &str,
) -> ContractResult<Vec<ObservationProjection>> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if entry.sequence != index as u64 {
                return Err(fault(
                    "reordered-trace",
                    &format!("{path}/{index}/sequence"),
                    format!("{path} sequence must be contiguous and ordered"),
                ));
            }
            require_token(&entry.entry_type, &format!("{path}/{index}/type"))?;
            Ok(ObservationProjection {
                sequence: entry.sequence,
                entry_type: entry.entry_type.clone(),
                canonical_utf8: canonical_utf8(&entry.payload)?,
                root: content_root("observation", &entry.payload)?,
            })
        })
        .collect()
}

fn validate_decision(
    decision: &Decision,
    receipt: &ReceiptEnvelope,
    path: &str,
) -> ContractResult<()> {
    if decision.action.is_some() == decision.fault.is_some() {
        return Err(fault(
            "invalid-trace-decision",
            path,
            "decision must contain exactly one action or typed fault",
        ));
    }
    if let Some(action) = &decision.action {
        require_token(action, &format!("{path}/action"))?;
        if receipt.outcome == "rejected" || receipt.fault.is_some() {
            return Err(fault(
                "invalid-trace-decision",
                path,
                "an action cannot bind a rejected receipt",
            ));
        }
    } else if let Some(decision_fault) = &decision.fault {
        decision_fault.validate()?;
        if receipt.outcome != "rejected" || receipt.fault.as_ref() != Some(decision_fault) {
            return Err(fault(
                "invalid-trace-decision",
                path,
                "typed fault and rejected receipt must match exactly",
            ));
        }
    }
    Ok(())
}

fn project_step(
    step: TraceStep,
    index: usize,
    prior_state_root: &str,
) -> ContractResult<(StepProjection, String)> {
    let path = format!("$/trace/steps/{index}");
    if step.sequence != index as u64 {
        return Err(fault(
            "reordered-trace",
            &format!("{path}/sequence"),
            "trace step sequence must be contiguous and ordered",
        ));
    }
    require_token(&step.id, &format!("{path}/id"))?;
    require_token(&step.operation, &format!("{path}/operation"))?;
    declared_root(
        &step.prior_state_root,
        prior_state_root,
        &format!("{path}/priorStateRoot"),
        "stale-prior-root",
    )?;
    step.event.validate()?;
    if step.event.subject_root != prior_state_root {
        return Err(fault(
            "stale-prior-root",
            &format!("{path}/event/subjectRoot"),
            "event subjectRoot must bind the exact prior state",
        ));
    }
    let event_value = serde_json::to_value(&step.event).map_err(|error| {
        fault(
            "canonicalization-failed",
            &format!("{path}/event"),
            error.to_string(),
        )
    })?;
    let event_root = content_root("observation", &event_value)?;

    if step.successor_state["schema"] != "buildchain-v4-delivery-warrant-state/v1" {
        return Err(fault(
            "unsupported-trace-version",
            &format!("{path}/successorState/schema"),
            "unsupported successor state schema",
        ));
    }
    if !step.successor_state["candidates"].is_array() {
        return Err(fault(
            "invalid-trace-shape",
            &format!("{path}/successorState/candidates"),
            "successor candidates must be an array",
        ));
    }
    let generation = state_counter(
        &step.successor_state,
        "generation",
        &format!("{path}/successorState"),
    )?;
    let fencing_counter = state_counter(
        &step.successor_state,
        "fencingCounter",
        &format!("{path}/successorState"),
    )?;
    let successor_canonical_utf8 = canonical_utf8(&step.successor_state)?;
    let successor_root = declared_root(
        &step.successor_root,
        &content_root("queue-state", &step.successor_state)?,
        &format!("{path}/successorRoot"),
        "stale-successor-root",
    )?;

    step.receipt.validate()?;
    if step.receipt.event_root != event_root
        || step.receipt.prior_state_root.as_deref() != Some(prior_state_root)
        || step.receipt.next_state_root.as_deref() != Some(&successor_root)
    {
        return Err(fault(
            "stale-receipt-root",
            &format!("{path}/receipt"),
            "receipt roots must bind the event and exact state transition",
        ));
    }
    validate_decision(&step.decision, &step.receipt, &format!("{path}/decision"))?;
    if step.decision.fault.is_some() && !step.effects.is_empty() {
        return Err(fault(
            "invalid-trace-effects",
            &format!("{path}/effects"),
            "rejected decisions must not declare effects",
        ));
    }
    let effects = project_entries(&step.effects, &format!("{path}/effects"))?;
    let observations = project_observations(&step.observations, &format!("{path}/observations"))?;
    let receipt_value = serde_json::to_value(&step.receipt).map_err(|error| {
        fault(
            "canonicalization-failed",
            &format!("{path}/receipt"),
            error.to_string(),
        )
    })?;
    let receipt_canonical_utf8 = canonical_utf8(&receipt_value)?;
    let receipt_root = declared_root(
        &step.receipt_root,
        &content_root("transition-receipt", &receipt_value)?,
        &format!("{path}/receiptRoot"),
        "stale-receipt-root",
    )?;

    Ok((
        StepProjection {
            sequence: step.sequence,
            id: step.id,
            operation: step.operation,
            decision: step.decision,
            event_root,
            successor_canonical_utf8,
            successor_root: successor_root.clone(),
            generation,
            fencing_counter,
            effects,
            observations,
            receipt_canonical_utf8,
            receipt_root,
        },
        successor_root,
    ))
}

pub fn run_delivery_warrant_trace_fixture(bytes: &[u8]) -> ContractResult<TraceRun> {
    if bytes.is_empty() || bytes.last() != Some(&b'\n') || bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(fault(
            "invalid-trace-bytes",
            "$",
            "retained trace bytes must be UTF-8 without BOM and end with one LF",
        ));
    }
    std::str::from_utf8(bytes).map_err(|_| {
        fault(
            "invalid-trace-bytes",
            "$",
            "retained trace bytes are not UTF-8",
        )
    })?;
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        let code = if error.is_syntax() || error.is_eof() {
            "invalid-trace-json"
        } else {
            "invalid-trace-shape"
        };
        fault(code, "$", error.to_string())
    })?;
    validate_closed_shape(&value)?;
    let fixture: TraceFixture = serde_json::from_value(value)
        .map_err(|error| fault("invalid-trace-shape", "$", error.to_string()))?;
    if fixture.schema_version != 1
        || fixture.contract != DELIVERY_WARRANT_TRACE_CONTRACT
        || fixture.runner != DELIVERY_WARRANT_RUNNER_CONTRACT
    {
        return Err(fault(
            "unsupported-trace-version",
            "$/schemaVersion",
            "unsupported trace fixture contract",
        ));
    }
    require_token(&fixture.trace.id, "$/trace/id")?;
    if !["golden", "property", "replay"].contains(&fixture.trace.kind.as_str()) {
        return Err(fault(
            "invalid-trace-kind",
            "$/trace/kind",
            "unsupported trace kind",
        ));
    }
    if fixture.trace.steps.is_empty() {
        return Err(fault(
            "incomplete-trace",
            "$/trace/steps",
            "trace must contain at least one step",
        ));
    }
    if fixture.trace.initial_state["schema"] != "buildchain-v4-delivery-warrant-state/v1"
        || !fixture.trace.initial_state["candidates"].is_array()
    {
        return Err(fault(
            "unsupported-trace-version",
            "$/trace/initialState",
            "unsupported Delivery Warrant initial state",
        ));
    }
    for name in ["generation", "fencingCounter"] {
        state_counter(&fixture.trace.initial_state, name, "$/trace/initialState")?;
    }
    let initial_state_root = declared_root(
        &fixture.trace.initial_state_root,
        &content_root("queue-state", &fixture.trace.initial_state)?,
        "$/trace/initialStateRoot",
        "stale-initial-root",
    )?;
    let mut prior_state_root = initial_state_root;
    let mut steps = Vec::with_capacity(fixture.trace.steps.len());
    for (index, step) in fixture.trace.steps.into_iter().enumerate() {
        let (projection, successor_root) = project_step(step, index, &prior_state_root)?;
        steps.push(projection);
        prior_state_root = successor_root;
    }
    let projection = SemanticProjection {
        schema: DELIVERY_WARRANT_PROJECTION_CONTRACT,
        trace_id: fixture.trace.id,
        trace_kind: fixture.trace.kind,
        steps,
    };
    let projection_value = serde_json::to_value(&projection).map_err(|error| {
        fault(
            "canonicalization-failed",
            "$",
            format!("cannot serialize semantic projection: {error}"),
        )
    })?;
    let projection_root = content_root("semantic-diff", &projection_value)?;
    validate_root(
        &fixture.expected_projection_root,
        "$/expectedProjectionRoot",
    )?;
    if fixture.expected_projection_root != projection_root {
        return Err(fault(
            "stale-projection-root",
            "$/expectedProjectionRoot",
            "expected projection root does not match the semantic projection",
        ));
    }
    Ok(TraceRun {
        projection: projection_value,
        projection_root,
    })
}
