use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

mod stage_capsule;
mod stage_capsule_resume;
mod stage_capsule_store;
mod trace;
mod warrant;

pub use stage_capsule::{
    RetentionPromise, STAGE_CAPSULE_AVAILABILITY_CONTRACT, STAGE_CAPSULE_CONTRACT,
    STAGE_CAPSULE_IDENTITY_CONTRACT, STAGE_CAPSULE_REUSE_CONTRACT, StageCapsule,
    StageCapsuleAvailability, StageCapsuleFixtureProjection, StageCapsuleIdentity,
    StageCapsuleReuseDecision, StageCapsuleReuseRequest, evaluate_stage_capsule_reuse,
    run_stage_capsule_fixture,
};
pub use stage_capsule_resume::{
    STAGE_CAPSULE_RESUME_PLAN_CONTRACT, STAGE_CAPSULE_RESUME_REQUEST_CONTRACT,
    StageCapsuleInvalidationCause, StageCapsuleResumeCandidate, StageCapsuleResumeDecision,
    StageCapsuleResumeEffect, StageCapsuleResumeNode, StageCapsuleResumePlan,
    StageCapsuleResumeRead, StageCapsuleResumeRequest, plan_stage_capsule_resume,
    plan_stage_capsule_resume_bytes,
};
pub use stage_capsule_store::{
    STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT, STAGE_CAPSULE_RETENTION_STATE_CONTRACT,
    STAGE_CAPSULE_STORE_RECEIPT_CONTRACT, STAGE_CAPSULE_TRANSPORT_CONTRACT,
    StageCapsuleOutputManifest, StageCapsuleRetentionState, StageCapsuleStoreFixtureProjection,
    StageCapsuleStoreReceipt, StageCapsuleTransport, run_stage_capsule_store_fixture,
    stage_capsule_blob_root,
};

pub use trace::{
    DELIVERY_WARRANT_PROJECTION_CONTRACT, DELIVERY_WARRANT_RUNNER_CONTRACT,
    DELIVERY_WARRANT_TRACE_CONTRACT, TraceRun, run_delivery_warrant_trace_fixture,
};
pub use warrant::{
    Candidate, CandidateStatus, DELIVERY_WARRANT_EVENTS, DELIVERY_WARRANT_LEGACY_DISAGREEMENTS,
    DELIVERY_WARRANT_PRIMITIVES, DELIVERY_WARRANT_READ_PROJECTION_CONTRACT,
    DELIVERY_WARRANT_STATE_CONTRACT, DELIVERY_WARRANT_STATES, DeclarativeEffect,
    DeliveryWarrantPolicy, DeliveryWarrantReadProjection, DeliveryWarrantState, DomainDecision,
    DomainTransition, RetryDirective, TerminalRecord, Warrant, WarrantEventKind,
    decide_delivery_warrant, expected_old, fold_delivery_warrant,
    project_delivery_warrant_state_bytes, provider_conflict, reconcile_response_loss,
    transition_delivery_warrant, typed_retry,
};

pub const CANONICAL_JSON_CONTRACT: &str = "buildchain-canonical-json/v1";
pub const EVENT_ENVELOPE_CONTRACT: &str = "buildchain-v4-event-envelope/v1";
pub const RECEIPT_ENVELOPE_CONTRACT: &str = "buildchain-v4-receipt-envelope/v1";
pub const CONTRACT_FAULT_CONTRACT: &str = "buildchain-v4-contract-fault/v1";
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub type ContractResult<T> = Result<T, Box<ContractFault>>;

const ROOT_DOMAINS: &[&str] = &[
    "queue-state",
    "candidate-identity",
    "fencing-token",
    "transition-receipt",
    "observation",
    "semantic-diff",
    "bootstrap-evidence",
    "stage-capsule-identity",
    "stage-capsule",
    "stage-capsule-availability",
    "stage-capsule-output-manifest",
    "stage-capsule-retention-promise",
    "stage-capsule-retention-state",
    "stage-capsule-transport",
    "stage-capsule-store-receipt",
    "stage-capsule-quarantine",
    "stage-capsule-resume-observation",
    "stage-capsule-resume-plan",
    "stage-capsule-artifact-manifest",
    "stage-capsule-artifact-content",
    "stage-capsule-fault-campaign",
    "stage-capsule-seed-evidence",
    "stage-capsule-resume-evidence",
    "stage-capsule-platform-qualification",
    "stage-capsule-qualification",
    "stage-capsule-wave-reconciliation",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractFault {
    pub schema: String,
    pub code: String,
    #[serde(rename = "class")]
    pub fault_class: String,
    pub path: String,
    pub message: String,
    pub retry: String,
}

impl ContractFault {
    pub(crate) fn validation(code: &str, path: &str, message: impl Into<String>) -> Self {
        Self {
            schema: CONTRACT_FAULT_CONTRACT.to_owned(),
            code: code.to_owned(),
            fault_class: "validation".to_owned(),
            path: path.to_owned(),
            message: message.into(),
            retry: "stop".to_owned(),
        }
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != CONTRACT_FAULT_CONTRACT
            || !ascii_token(&self.code)
            || !["validation", "concurrency", "authority", "idempotence"]
                .contains(&self.fault_class.as_str())
            || !self.path.starts_with('$')
            || self.message.is_empty()
            || !["stop", "reread", "redecide", "reselect"].contains(&self.retry.as_str())
        {
            return Err(Box::new(Self::validation(
                "invalid-fault",
                "$.fault",
                "typed fault is outside the v1 contract",
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    pub schema: String,
    pub event_id: String,
    pub event_type: String,
    pub occurred_at: String,
    pub subject_root: String,
    pub payload: Value,
}

impl EventEnvelope {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != EVENT_ENVELOPE_CONTRACT || !ascii_token(&self.event_type) {
            return Err(Box::new(ContractFault::validation(
                "invalid-event",
                "$.eventType",
                "event schema or type is unsupported",
            )));
        }
        validate_root(&self.event_id, "$.eventId")?;
        validate_root(&self.subject_root, "$.subjectRoot")?;
        validate_clock(&self.occurred_at, "$.occurredAt")?;
        canonical_bytes(&self.payload)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptEnvelope {
    pub schema: String,
    pub receipt_type: String,
    pub recorded_at: String,
    pub event_root: String,
    pub prior_state_root: Option<String>,
    pub next_state_root: Option<String>,
    pub outcome: String,
    pub fault: Option<ContractFault>,
}

impl ReceiptEnvelope {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != RECEIPT_ENVELOPE_CONTRACT || !ascii_token(&self.receipt_type) {
            return Err(Box::new(ContractFault::validation(
                "invalid-receipt",
                "$.receiptType",
                "receipt schema or type is unsupported",
            )));
        }
        validate_clock(&self.recorded_at, "$.recordedAt")?;
        validate_root(&self.event_root, "$.eventRoot")?;
        if let Some(root) = &self.prior_state_root {
            validate_root(root, "$.priorStateRoot")?;
        }
        if let Some(root) = &self.next_state_root {
            validate_root(root, "$.nextStateRoot")?;
        }
        if !["accepted", "rejected", "noop"].contains(&self.outcome.as_str())
            || (self.outcome == "rejected") != self.fault.is_some()
        {
            return Err(Box::new(ContractFault::validation(
                "invalid-receipt",
                "$.outcome",
                "receipt outcome and fault do not match",
            )));
        }
        if let Some(fault) = &self.fault {
            fault.validate()?;
        }
        Ok(())
    }
}

pub(crate) fn ascii_token(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.ends_with('-')
        && !value.contains("--")
}

fn canonical_value(value: &Value, path: &str) -> ContractResult<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            let supported = number
                .as_i64()
                .is_some_and(|integer| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer))
                && number.to_string() != "-0";
            if !supported {
                return Err(Box::new(ContractFault::validation(
                    "unsupported-number",
                    path,
                    "number must be an integer in the JavaScript safe range",
                )));
            }
            Ok(value.clone())
        }
        Value::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, entry)| canonical_value(entry, &format!("{path}/{index}")))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut result = BTreeMap::new();
            for (key, entry) in object {
                if key.is_empty() || !key.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
                    return Err(Box::new(ContractFault::validation(
                        "unsupported-object-key",
                        &format!("{path}/{key}"),
                        "object keys must be non-empty printable ASCII",
                    )));
                }
                result.insert(
                    key.clone(),
                    canonical_value(entry, &format!("{path}/{key}"))?,
                );
            }
            Ok(Value::Object(result.into_iter().collect()))
        }
    }
}

pub fn canonical_bytes(value: &Value) -> ContractResult<Vec<u8>> {
    let normalized = canonical_value(value, "$")?;
    let mut bytes = serde_json::to_vec(&normalized).map_err(|error| {
        Box::new(ContractFault::validation(
            "canonicalization-failed",
            "$",
            format!("cannot serialize canonical JSON: {error}"),
        ))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn content_root(domain: &str, value: &Value) -> ContractResult<String> {
    if !ROOT_DOMAINS.contains(&domain) {
        return Err(Box::new(ContractFault::validation(
            "unsupported-root-domain",
            "$.domain",
            format!("unsupported root domain: {domain}"),
        )));
    }
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(canonical_bytes(value)?);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub fn validate_root(value: &str, path: &str) -> ContractResult<()> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Box::new(ContractFault::validation(
            "invalid-root",
            path,
            "root must be lowercase sha256",
        )));
    }
    Ok(())
}

pub fn validate_clock(value: &str, path: &str) -> ContractResult<()> {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 24
        && [4, 7].iter().all(|index| bytes[*index] == b'-')
        && bytes[10] == b'T'
        && [13, 16].iter().all(|index| bytes[*index] == b':')
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            [4, 7, 10, 13, 16, 19, 23].contains(&index) || byte.is_ascii_digit()
        });
    if !shape {
        return Err(Box::new(ContractFault::validation(
            "invalid-clock",
            path,
            "clock must be RFC3339 UTC with millisecond precision",
        )));
    }
    let number =
        |range: std::ops::Range<usize>| -> u32 { value[range].parse::<u32>().unwrap_or_default() };
    let year = number(0..4);
    let month = number(5..7);
    let day = number(8..10);
    let hour = number(11..13);
    let minute = number(14..16);
    let second = number(17..19);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        0,
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if year == 0
        || !(1..=12).contains(&month)
        || day == 0
        || day > days[month as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(Box::new(ContractFault::validation(
            "invalid-clock",
            path,
            "clock is not a real UTC instant",
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bytes_sort_ascii_keys_and_end_with_lf() {
        let value = serde_json::json!({"z": 1, "A": [true, null], "a": "é"});
        assert_eq!(
            canonical_bytes(&value).unwrap(),
            "{\"A\":[true,null],\"a\":\"é\",\"z\":1}\n".as_bytes()
        );
    }

    #[test]
    fn rejects_unsafe_numbers_non_ascii_keys_and_invalid_clocks() {
        assert!(canonical_bytes(&serde_json::json!(9_007_199_254_740_992_u64)).is_err());
        assert!(canonical_bytes(&serde_json::from_str("-0").unwrap()).is_err());
        assert!(canonical_bytes(&serde_json::json!({"é": 1})).is_err());
        assert!(validate_clock("2026-02-30T00:00:00.000Z", "$.clock").is_err());
    }
}
