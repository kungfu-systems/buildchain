use serde::{Deserialize, Serialize};

use crate::{ContractFault, ContractResult, content_root};

use super::{PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT, ProviderOperationEntry, fault};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationJournalState {
    pub schema: String,
    pub operation_root: String,
    pub phase: String,
    pub entry_count: u64,
    pub attempt_count: u64,
    pub last_entry_root: String,
    pub active_attempt_root: Option<String>,
    pub last_observation_root: Option<String>,
    pub confirmation_root: Option<String>,
    pub reconciliation_root: Option<String>,
}

impl ProviderOperationJournalState {
    pub(super) fn root(&self) -> ContractResult<String> {
        content_root(
            "provider-operation-journal-state",
            &serde_json::to_value(self)
                .map_err(|error| fault("canonicalization-failed", "$/state", error.to_string()))?,
        )
    }
}

fn transition_fault(entry: &ProviderOperationEntry, phase: &str) -> Box<ContractFault> {
    fault(
        "impossible-provider-operation-transition",
        &format!("$/entries/{}/kind", entry.sequence()),
        format!(
            "{} cannot follow provider operation phase {phase}",
            entry.kind()
        ),
    )
}

pub fn fold_provider_operation_journal(
    entries: &[ProviderOperationEntry],
) -> ContractResult<ProviderOperationJournalState> {
    if entries.is_empty() {
        return Err(fault(
            "invalid-provider-operation-journal",
            "$/entries",
            "provider operation journal must contain an intent",
        ));
    }
    let mut state: Option<ProviderOperationJournalState> = None;
    let mut authority_root: Option<String> = None;
    let mut last_observation_status: Option<String> = None;
    for (index, entry) in entries.iter().enumerate() {
        entry.validate()?;
        if entry.sequence() != index as u64 {
            return Err(fault(
                "provider-operation-sequence-conflict",
                &format!("$/entries/{index}/sequence"),
                "provider operation sequence must be contiguous and zero-based",
            ));
        }
        let expected_prior = state.as_ref().map(|value| value.last_entry_root.as_str());
        if entry.prior_entry_root() != expected_prior {
            return Err(fault(
                "provider-operation-causal-link-mismatch",
                &format!("$/entries/{index}/priorEntryRoot"),
                "priorEntryRoot does not bind the append-only predecessor",
            ));
        }
        if index == 0 {
            let ProviderOperationEntry::Intent(intent) = entry else {
                return Err(transition_fault(entry, "empty"));
            };
            if intent.sequence != 0 || intent.prior_entry_root.is_some() {
                return Err(fault(
                    "provider-operation-sequence-conflict",
                    "$/entries/0",
                    "intent must be the zero-rooted first journal entry",
                ));
            }
            authority_root = Some(intent.operation.authority_root.clone());
            state = Some(ProviderOperationJournalState {
                schema: PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT.to_owned(),
                operation_root: intent.operation_root.clone(),
                phase: "intended".to_owned(),
                entry_count: 1,
                attempt_count: 0,
                last_entry_root: intent.entry_root.clone(),
                active_attempt_root: None,
                last_observation_root: None,
                confirmation_root: None,
                reconciliation_root: None,
            });
            continue;
        }
        let current = state
            .as_mut()
            .expect("intent initializes provider operation state");
        if entry.operation_root() != current.operation_root {
            return Err(fault(
                "provider-operation-identity-drift",
                &format!("$/entries/{index}/operationRoot"),
                "retry records must preserve logical operation identity",
            ));
        }
        match entry {
            ProviderOperationEntry::Intent(_) => {
                return Err(transition_fault(entry, &current.phase));
            }
            ProviderOperationEntry::Attempt(attempt) => {
                if !["intended", "retryable"].contains(&current.phase.as_str()) {
                    return Err(transition_fault(entry, &current.phase));
                }
                if attempt.attempt_ordinal != current.attempt_count + 1 {
                    return Err(fault(
                        "provider-operation-attempt-conflict",
                        &format!("$/entries/{index}/attemptOrdinal"),
                        "attemptOrdinal must append exactly one logical retry attempt",
                    ));
                }
                current.phase = "attempting".to_owned();
                current.attempt_count += 1;
                current.active_attempt_root = Some(attempt.entry_root.clone());
                current.last_observation_root = None;
                last_observation_status = None;
            }
            ProviderOperationEntry::Observation(observation) => {
                if current.phase != "attempting" {
                    return Err(transition_fault(entry, &current.phase));
                }
                if Some(observation.attempt_root.as_str()) != current.active_attempt_root.as_deref()
                {
                    return Err(fault(
                        "provider-operation-causal-link-mismatch",
                        &format!("$/entries/{index}/attemptRoot"),
                        "observation must bind the active rooted attempt",
                    ));
                }
                current.phase = "observed".to_owned();
                current.last_observation_root = Some(observation.entry_root.clone());
                last_observation_status = Some(observation.status.clone());
            }
            ProviderOperationEntry::Reconciliation(reconciliation) => {
                if Some(reconciliation.authority_root.as_str()) != authority_root.as_deref() {
                    return Err(fault(
                        "provider-operation-authority-escalation",
                        &format!("$/entries/{index}/authorityRoot"),
                        "reconciliation cannot change the declared authority root",
                    ));
                }
                if current.phase != "observed" {
                    return Err(transition_fault(entry, &current.phase));
                }
                if Some(reconciliation.observation_root.as_str())
                    != current.last_observation_root.as_deref()
                {
                    return Err(fault(
                        "provider-operation-causal-link-mismatch",
                        &format!("$/entries/{index}/observationRoot"),
                        "reconciliation must bind the latest rooted observation",
                    ));
                }
                let observed = last_observation_status.as_deref();
                if (reconciliation.disposition == "retry" && observed == Some("succeeded"))
                    || (reconciliation.disposition == "confirm" && observed != Some("succeeded"))
                {
                    return Err(fault(
                        "invalid-provider-operation-reconciliation",
                        &format!("$/entries/{index}/disposition"),
                        "reconciliation disposition conflicts with the rooted observation",
                    ));
                }
                current.phase = match reconciliation.disposition.as_str() {
                    "retry" => "retryable",
                    "confirm" => "confirmable",
                    _ => "terminal",
                }
                .to_owned();
                current.reconciliation_root = Some(reconciliation.entry_root.clone());
            }
            ProviderOperationEntry::Confirmation(confirmation) => {
                if Some(confirmation.authority_root.as_str()) != authority_root.as_deref() {
                    return Err(fault(
                        "provider-operation-authority-escalation",
                        &format!("$/entries/{index}/authorityRoot"),
                        "confirmation cannot change the declared authority root",
                    ));
                }
                if ["confirmed", "rejected"].contains(&current.phase.as_str()) {
                    return Err(fault(
                        "conflicting-provider-operation-confirmation",
                        &format!("$/entries/{index}"),
                        "a terminal provider operation cannot receive another confirmation",
                    ));
                }
                if !["observed", "confirmable"].contains(&current.phase.as_str())
                    || last_observation_status.as_deref() != Some("succeeded")
                    || Some(confirmation.observation_root.as_str())
                        != current.last_observation_root.as_deref()
                {
                    return Err(fault(
                        "confirmation-without-rooted-observation",
                        &format!("$/entries/{index}/observationRoot"),
                        "confirmation requires the latest successful rooted observation",
                    ));
                }
                current.phase = confirmation.outcome.clone();
                current.confirmation_root = Some(confirmation.entry_root.clone());
            }
        }
        current.entry_count += 1;
        current.last_entry_root = entry.entry_root().to_owned();
    }
    Ok(state.expect("non-empty provider operation journal initializes state"))
}
