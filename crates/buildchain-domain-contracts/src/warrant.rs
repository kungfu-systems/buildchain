use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    CONTRACT_FAULT_CONTRACT, ContractFault, ContractResult, EventEnvelope, MAX_SAFE_INTEGER,
    RECEIPT_ENVELOPE_CONTRACT, ReceiptEnvelope, content_root, validate_clock, validate_root,
};

pub const DELIVERY_WARRANT_STATE_CONTRACT: &str = "buildchain-v4-delivery-warrant-state/v1";
pub const DELIVERY_WARRANT_READ_PROJECTION_CONTRACT: &str =
    "buildchain-v4-delivery-warrant-read-projection/v1";

pub const DELIVERY_WARRANT_STATES: [&str; 9] = [
    "queued",
    "selected",
    "proving",
    "waiting",
    "blocked",
    "merged",
    "terminal-failure",
    "dequeued",
    "cancelled",
];

pub const DELIVERY_WARRANT_EVENTS: [&str; 7] = [
    "submit",
    "select",
    "lease",
    "renew",
    "recover-expired",
    "settle",
    "cancel",
];

pub const DELIVERY_WARRANT_PRIMITIVES: [&str; 9] = [
    "canonical-json",
    "content-root",
    "expected-old",
    "explicit-clock",
    "decide-fold",
    "effects",
    "observations",
    "typed-retry",
    "receipts",
];

pub const DELIVERY_WARRANT_LEGACY_DISAGREEMENTS: [&str; 7] = [
    "ambient-api-clock",
    "duplicate-submit-mutates-root",
    "waiting-blocked-have-no-public-transition",
    "manifest-event-aliases",
    "response-loss-asymmetry",
    "receipt-bytes-not-in-queue-store",
    "legacy-key-sort-not-portable",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateStatus {
    Queued,
    Selected,
    Proving,
    Waiting,
    Blocked,
    Merged,
    TerminalFailure,
    Dequeued,
    Cancelled,
}

impl CandidateStatus {
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Selected | Self::Proving | Self::Waiting | Self::Blocked
        )
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Merged | Self::TerminalFailure | Self::Dequeued | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalRecord {
    pub outcome: CandidateStatus,
    pub evidence_root: String,
    pub closed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub candidate_id: String,
    pub pull_request_number: u64,
    pub status: CandidateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enqueued_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recoveries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Warrant {
    pub candidate_id: String,
    pub fencing_token: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryWarrantState {
    pub schema: String,
    pub generation: u64,
    pub fencing_counter: u64,
    pub active_warrant: Option<Warrant>,
    pub candidates: Vec<Candidate>,
}

impl Default for DeliveryWarrantState {
    fn default() -> Self {
        Self {
            schema: DELIVERY_WARRANT_STATE_CONTRACT.to_owned(),
            generation: 0,
            fencing_counter: 0,
            active_warrant: None,
            candidates: Vec::new(),
        }
    }
}

impl DeliveryWarrantState {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != DELIVERY_WARRANT_STATE_CONTRACT {
            return Err(validation_fault(
                "unsupported-state-version",
                "$/state/schema",
                "unsupported Delivery Warrant state schema",
            ));
        }
        safe_counter(self.generation, "$/state/generation")?;
        safe_counter(self.fencing_counter, "$/state/fencingCounter")?;
        let mut ids = BTreeSet::new();
        let mut pulls = BTreeSet::new();
        for (index, candidate) in self.candidates.iter().enumerate() {
            let path = format!("$/state/candidates/{index}");
            if candidate.candidate_id.is_empty()
                || !candidate.candidate_id.is_ascii()
                || candidate.pull_request_number == 0
                || candidate.pull_request_number > MAX_SAFE_INTEGER as u64
            {
                return Err(validation_fault(
                    "invalid-candidate",
                    &path,
                    "candidate identity must be non-empty ASCII with a positive safe pull number",
                ));
            }
            if !ids.insert(candidate.candidate_id.as_str())
                || !pulls.insert(candidate.pull_request_number)
            {
                return Err(validation_fault(
                    "duplicate-candidate",
                    &path,
                    "candidate and pull request identities must be unique",
                ));
            }
            for (field, value) in [
                ("enqueuedAt", candidate.enqueued_at.as_deref()),
                ("updatedAt", candidate.updated_at.as_deref()),
            ] {
                if let Some(value) = value {
                    validate_clock(value, &format!("{path}/{field}"))?;
                }
            }
            if let Some(attempts) = candidate.attempts {
                if attempts == 0 {
                    return Err(validation_fault(
                        "invalid-candidate",
                        &format!("{path}/attempts"),
                        "candidate attempts must be positive",
                    ));
                }
                safe_counter(attempts, &format!("{path}/attempts"))?;
            }
            if let Some(recoveries) = candidate.recoveries {
                safe_counter(recoveries, &format!("{path}/recoveries"))?;
            }
            if let Some(terminal) = &candidate.terminal {
                if !candidate.status.is_terminal() || terminal.outcome != candidate.status {
                    return Err(validation_fault(
                        "invalid-terminal-record",
                        &format!("{path}/terminal"),
                        "terminal record must match a terminal candidate status",
                    ));
                }
                validate_root(
                    &terminal.evidence_root,
                    &format!("{path}/terminal/evidenceRoot"),
                )?;
                validate_clock(&terminal.closed_at, &format!("{path}/terminal/closedAt"))?;
            }
        }

        let active = self
            .candidates
            .iter()
            .filter(|candidate| candidate.status.is_active())
            .collect::<Vec<_>>();
        match &self.active_warrant {
            Some(warrant) => {
                if warrant.candidate_id.is_empty()
                    || warrant.fencing_token.is_empty()
                    || warrant.generation == 0
                    || warrant.generation > self.generation
                    || active.len() != 1
                    || active[0].candidate_id != warrant.candidate_id
                {
                    return Err(validation_fault(
                        "invalid-active-warrant",
                        "$/state/activeWarrant",
                        "one active candidate must match the current Warrant",
                    ));
                }
                for (field, value) in [
                    ("issuedAt", warrant.issued_at.as_deref()),
                    ("expiresAt", warrant.expires_at.as_deref()),
                ] {
                    if let Some(value) = value {
                        validate_clock(value, &format!("$/state/activeWarrant/{field}"))?;
                    }
                }
                if let (Some(issued), Some(expires)) = (&warrant.issued_at, &warrant.expires_at)
                    && expires <= issued
                {
                    return Err(validation_fault(
                        "invalid-lease",
                        "$/state/activeWarrant/expiresAt",
                        "lease expiry must be after issuance",
                    ));
                }
            }
            None if !active.is_empty() => {
                return Err(validation_fault(
                    "missing-active-warrant",
                    "$/state/activeWarrant",
                    "active candidate exists without an active Warrant",
                ));
            }
            None => {}
        }
        Ok(())
    }

    pub fn root(&self) -> ContractResult<String> {
        self.validate()?;
        let value = serde_json::to_value(self).map_err(|error| {
            validation_fault(
                "canonicalization-failed",
                "$/state",
                format!("cannot serialize Delivery Warrant state: {error}"),
            )
        })?;
        content_root("queue-state", &value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryWarrantReadProjection {
    pub schema: &'static str,
    pub state: DeliveryWarrantState,
    pub state_root: String,
}

pub fn project_delivery_warrant_state_bytes(
    bytes: &[u8],
) -> ContractResult<DeliveryWarrantReadProjection> {
    let state: DeliveryWarrantState = serde_json::from_slice(bytes).map_err(|error| {
        validation_fault(
            "invalid-read-state",
            "$/state",
            format!("cannot decode Delivery Warrant read state: {error}"),
        )
    })?;
    let state_root = state.root()?;
    Ok(DeliveryWarrantReadProjection {
        schema: DELIVERY_WARRANT_READ_PROJECTION_CONTRACT,
        state,
        state_root,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryWarrantPolicy {
    pub lease_seconds: u64,
    pub maximum_conflict_retries: u8,
}

impl Default for DeliveryWarrantPolicy {
    fn default() -> Self {
        Self {
            lease_seconds: 3_600,
            maximum_conflict_retries: 1,
        }
    }
}

impl DeliveryWarrantPolicy {
    fn validate(self) -> ContractResult<()> {
        if self.lease_seconds == 0 || self.lease_seconds > MAX_SAFE_INTEGER as u64 {
            return Err(validation_fault(
                "invalid-lease",
                "$/policy/leaseSeconds",
                "lease duration must be a positive safe integer",
            ));
        }
        if self.maximum_conflict_retries > 1 {
            return Err(validation_fault(
                "unbounded-retry-policy",
                "$/policy/maximumConflictRetries",
                "v1 permits at most one reread and redecision",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarrantEventKind {
    Submit,
    Select,
    Lease,
    Renew,
    RecoverExpired,
    Settle,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDirective {
    Stop,
    Reread,
    Redecide,
    Reselect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclarativeEffect {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub effect_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum Mutation {
    None,
    Submit(Candidate),
    TouchDuplicate {
        index: usize,
        now: String,
    },
    Select {
        index: usize,
        warrant: Warrant,
    },
    RecoverAndSelect {
        index: usize,
        warrant: Warrant,
    },
    Renew {
        index: usize,
        expires_at: String,
        now: String,
    },
    Recover {
        index: usize,
        now: String,
    },
    Settle {
        index: usize,
        terminal: TerminalRecord,
        clear_warrant: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DomainDecision {
    pub event_kind: WarrantEventKind,
    pub action: Option<String>,
    pub fault: Option<ContractFault>,
    mutation: Mutation,
}

impl DomainDecision {
    fn accepted(event_kind: WarrantEventKind, action: &str, mutation: Mutation) -> Self {
        Self {
            event_kind,
            action: Some(action.to_owned()),
            fault: None,
            mutation,
        }
    }

    fn rejected(event_kind: WarrantEventKind, fault: ContractFault) -> Self {
        Self {
            event_kind,
            action: None,
            fault: Some(fault),
            mutation: Mutation::None,
        }
    }

    pub fn is_noop(&self) -> bool {
        matches!(self.mutation, Mutation::None) && self.fault.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DomainTransition {
    pub decision: DomainDecision,
    pub prior_state_root: String,
    pub successor_state: DeliveryWarrantState,
    pub successor_root: String,
    pub effects: Vec<DeclarativeEffect>,
    pub receipt: ReceiptEnvelope,
    pub receipt_root: String,
}

fn validation_fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault {
        schema: CONTRACT_FAULT_CONTRACT.to_owned(),
        code: code.to_owned(),
        fault_class: "validation".to_owned(),
        path: path.to_owned(),
        message: message.into(),
        retry: "stop".to_owned(),
    })
}

fn typed_fault(
    code: &str,
    class: &str,
    path: &str,
    message: impl Into<String>,
    retry: RetryDirective,
) -> ContractFault {
    ContractFault {
        schema: CONTRACT_FAULT_CONTRACT.to_owned(),
        code: code.to_owned(),
        fault_class: class.to_owned(),
        path: path.to_owned(),
        message: message.into(),
        retry: match retry {
            RetryDirective::Stop => "stop",
            RetryDirective::Reread => "reread",
            RetryDirective::Redecide => "redecide",
            RetryDirective::Reselect => "reselect",
        }
        .to_owned(),
    }
}

fn safe_counter(value: u64, path: &str) -> ContractResult<()> {
    if value > MAX_SAFE_INTEGER as u64 {
        return Err(validation_fault(
            "unsafe-counter",
            path,
            "counter exceeds the JavaScript-safe integer range",
        ));
    }
    Ok(())
}

pub fn expected_old(expected: &str, observed: &str) -> ContractResult<()> {
    if expected == observed {
        Ok(())
    } else {
        Err(Box::new(typed_fault(
            "stale-expected-old",
            "concurrency",
            "$/event/subjectRoot",
            "event does not bind the current queue root",
            RetryDirective::Reread,
        )))
    }
}

pub fn typed_retry(fault: &ContractFault, attempt: u8) -> RetryDirective {
    if attempt > 0 {
        return RetryDirective::Stop;
    }
    match fault.code.as_str() {
        "stale-expected-old" => RetryDirective::Reread,
        "lease-expired" | "stale-fencing-token" | "stale-lease-generation" => {
            RetryDirective::Reselect
        }
        "response-loss" => RetryDirective::Reread,
        _ if fault.retry == "redecide" => RetryDirective::Redecide,
        _ => RetryDirective::Stop,
    }
}

pub fn reconcile_response_loss(
    committed_successor_root: &str,
    observed_state_root: &str,
) -> ContractResult<RetryDirective> {
    if committed_successor_root == observed_state_root {
        Ok(RetryDirective::Stop)
    } else {
        Err(Box::new(typed_fault(
            "response-loss",
            "concurrency",
            "$/observation/stateRoot",
            "readback does not match the exact committed successor",
            RetryDirective::Reread,
        )))
    }
}

pub fn provider_conflict(observation_root: &str) -> ContractResult<ContractFault> {
    validate_root(observation_root, "$/observation/root")?;
    Ok(typed_fault(
        "provider-conflict",
        "authority",
        "$/observation/root",
        "provider rejected the declarative effect; no queue transition was invented",
        RetryDirective::Stop,
    ))
}

fn event_kind(event_type: &str) -> Option<WarrantEventKind> {
    match event_type {
        "submit" | "candidate-submitted" => Some(WarrantEventKind::Submit),
        "select" | "warrant-selected" => Some(WarrantEventKind::Select),
        "lease" => Some(WarrantEventKind::Lease),
        "renew" | "heartbeat-requested" => Some(WarrantEventKind::Renew),
        "recover-expired" | "warrant-expiry-requested" => Some(WarrantEventKind::RecoverExpired),
        "settle" | "warrant-settlement-requested" => Some(WarrantEventKind::Settle),
        "cancel" | "candidate-cancellation-requested" => Some(WarrantEventKind::Cancel),
        _ => None,
    }
}

fn string_field<'a>(payload: &'a Value, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(Value::as_str)
}

fn u64_field(payload: &Value, field: &str) -> Option<u64> {
    payload.get(field).and_then(Value::as_u64)
}

fn payload_fault(kind: WarrantEventKind, field: &str, message: &str) -> DomainDecision {
    DomainDecision::rejected(
        kind,
        typed_fault(
            "invalid-event-payload",
            "validation",
            &format!("$/event/payload/{field}"),
            message,
            RetryDirective::Stop,
        ),
    )
}

mod decision;
mod transition;

pub use decision::decide_delivery_warrant;
pub use transition::{fold_delivery_warrant, transition_delivery_warrant};
