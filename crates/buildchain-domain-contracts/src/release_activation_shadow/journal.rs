use crate::ContractResult;
use crate::provider_operation_journal::{
    PROVIDER_OPERATION_ATTEMPT_CONTRACT, PROVIDER_OPERATION_CONFIRMATION_CONTRACT,
    PROVIDER_OPERATION_INTENT_CONTRACT, PROVIDER_OPERATION_OBSERVATION_CONTRACT,
    PROVIDER_OPERATION_RECONCILIATION_CONTRACT, ProviderOperationAttempt,
    ProviderOperationConfirmation, ProviderOperationEntry, ProviderOperationIntent,
    ProviderOperationObservation, ProviderOperationReconciliation,
};

use super::{ReleaseActivationEvent, ReleaseActivationPlanStep, ReleaseActivationRequest};

fn append_rooted(
    entries: &mut Vec<ProviderOperationEntry>,
    entry: ProviderOperationEntry,
) -> ContractResult<()> {
    let root = entry.calculated_root()?;
    let rooted = match entry {
        ProviderOperationEntry::Intent(mut value) => {
            value.entry_root = root;
            ProviderOperationEntry::Intent(value)
        }
        ProviderOperationEntry::Attempt(mut value) => {
            value.entry_root = root;
            ProviderOperationEntry::Attempt(value)
        }
        ProviderOperationEntry::Observation(mut value) => {
            value.entry_root = root;
            ProviderOperationEntry::Observation(value)
        }
        ProviderOperationEntry::Reconciliation(mut value) => {
            value.entry_root = root;
            ProviderOperationEntry::Reconciliation(value)
        }
        ProviderOperationEntry::Confirmation(mut value) => {
            value.entry_root = root;
            ProviderOperationEntry::Confirmation(value)
        }
    };
    entries.push(rooted);
    Ok(())
}

pub(super) fn materialize_journal(
    request: &ReleaseActivationRequest,
    step: &ReleaseActivationPlanStep,
    events: &[ReleaseActivationEvent],
) -> ContractResult<Vec<ProviderOperationEntry>> {
    let qualification_root = request
        .qualification_root
        .clone()
        .expect("plan validated qualification");
    let mut entries = Vec::new();
    append_rooted(
        &mut entries,
        ProviderOperationEntry::Intent(ProviderOperationIntent {
            schema: PROVIDER_OPERATION_INTENT_CONTRACT.to_owned(),
            sequence: 0,
            prior_entry_root: None,
            operation: step.operation.clone(),
            operation_root: step.operation_root.clone(),
            declared_at: request.declared_at.clone(),
            input_root: qualification_root.clone(),
            entry_root: String::new(),
        }),
    )?;
    let mut attempt_ordinal = 0;
    let mut attempt_root = None;
    let mut observation_root = None;
    for event in events {
        let sequence = entries.len() as u64;
        let prior_entry_root = entries.last().map(|entry| entry.entry_root().to_owned());
        let entry = match event {
            ReleaseActivationEvent::Attempt {
                attempted_at,
                effect_root,
                ..
            } => {
                attempt_ordinal += 1;
                ProviderOperationEntry::Attempt(ProviderOperationAttempt {
                    schema: PROVIDER_OPERATION_ATTEMPT_CONTRACT.to_owned(),
                    sequence,
                    prior_entry_root,
                    operation_root: step.operation_root.clone(),
                    attempt_ordinal,
                    attempted_at: attempted_at.clone(),
                    effect_root: effect_root.clone(),
                    entry_root: String::new(),
                })
            }
            ReleaseActivationEvent::Observation {
                observed_at,
                status,
                evidence_roots,
                ..
            } => ProviderOperationEntry::Observation(ProviderOperationObservation {
                schema: PROVIDER_OPERATION_OBSERVATION_CONTRACT.to_owned(),
                sequence,
                prior_entry_root,
                operation_root: step.operation_root.clone(),
                attempt_root: attempt_root
                    .clone()
                    .unwrap_or_else(|| qualification_root.clone()),
                observed_at: observed_at.clone(),
                status: status.clone(),
                evidence_roots: evidence_roots.clone(),
                entry_root: String::new(),
            }),
            ReleaseActivationEvent::Reconciliation {
                reconciled_at,
                disposition,
                authority_root,
                ..
            } => ProviderOperationEntry::Reconciliation(ProviderOperationReconciliation {
                schema: PROVIDER_OPERATION_RECONCILIATION_CONTRACT.to_owned(),
                sequence,
                prior_entry_root,
                operation_root: step.operation_root.clone(),
                observation_root: observation_root
                    .clone()
                    .unwrap_or_else(|| qualification_root.clone()),
                authority_root: authority_root.clone(),
                reconciled_at: reconciled_at.clone(),
                disposition: disposition.clone(),
                entry_root: String::new(),
            }),
            ReleaseActivationEvent::Confirmation {
                confirmed_at,
                outcome,
                authority_root,
                ..
            } => ProviderOperationEntry::Confirmation(ProviderOperationConfirmation {
                schema: PROVIDER_OPERATION_CONFIRMATION_CONTRACT.to_owned(),
                sequence,
                prior_entry_root,
                operation_root: step.operation_root.clone(),
                observation_root: observation_root
                    .clone()
                    .unwrap_or_else(|| qualification_root.clone()),
                authority_root: authority_root.clone(),
                confirmed_at: confirmed_at.clone(),
                outcome: outcome.clone(),
                entry_root: String::new(),
            }),
        };
        append_rooted(&mut entries, entry)?;
        match entries.last() {
            Some(ProviderOperationEntry::Attempt(value)) => {
                attempt_root = Some(value.entry_root.clone());
                observation_root = None;
            }
            Some(ProviderOperationEntry::Observation(value)) => {
                observation_root = Some(value.entry_root.clone());
            }
            _ => {}
        }
    }
    Ok(entries)
}
