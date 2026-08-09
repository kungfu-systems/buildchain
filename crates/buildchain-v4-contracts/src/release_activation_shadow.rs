use std::collections::{BTreeMap, BTreeSet};

use crate::{
    ContractFault, ContractResult, MAX_SAFE_INTEGER, ascii_token, content_root,
    fold_provider_operation_journal, validate_clock, validate_root,
};

mod journal;
mod model;
use journal::materialize_journal;
use model::{PlanPayload, PlanStepPayload, StatePayload};
pub use model::{
    RELEASE_ACTIVATION_PLAN_CONTRACT, RELEASE_ACTIVATION_REQUEST_CONTRACT,
    RELEASE_ACTIVATION_STATE_CONTRACT, ReleaseActivationEvent, ReleaseActivationPlan,
    ReleaseActivationPlanStep, ReleaseActivationProjection, ReleaseActivationRequest,
    ReleaseActivationState, ReleaseActivationStep, ReleaseActivationStepState,
};

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn normalize_values(values: &[String], path: &str) -> ContractResult<Vec<String>> {
    for (index, value) in values.iter().enumerate() {
        if !ascii_token(value) {
            return Err(fault(
                "invalid-release-activation-token",
                &format!("{path}/{index}"),
                "activation identifiers must be ASCII tokens",
            ));
        }
    }
    let mut normalized = values.to_vec();
    normalized.sort();
    if normalized.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(fault(
            "duplicate-release-activation-dependency",
            path,
            "activation dependencies must not contain duplicates",
        ));
    }
    Ok(normalized)
}

fn normalize_roots(values: &[String], path: &str) -> ContractResult<Vec<String>> {
    if values.is_empty() {
        return Err(fault(
            "unrooted-release-activation-observation",
            path,
            "provider-neutral observation evidence must be rooted",
        ));
    }
    for (index, value) in values.iter().enumerate() {
        validate_root(value, &format!("{path}/{index}"))?;
    }
    let mut normalized = values.to_vec();
    normalized.sort();
    if normalized.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(fault(
            "duplicate-release-activation-observation-root",
            path,
            "provider-neutral evidence roots must be unique",
        ));
    }
    Ok(normalized)
}

fn visit_step(
    id: &str,
    steps: &BTreeMap<String, ReleaseActivationPlanStep>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> ContractResult<()> {
    if visiting.contains(id) {
        return Err(fault(
            "release-activation-dependency-cycle",
            &format!("$/steps/{id}/dependencies"),
            "release activation dependencies must be acyclic",
        ));
    }
    if visited.contains(id) {
        return Ok(());
    }
    visiting.insert(id.to_owned());
    for dependency in &steps[id].dependencies {
        visit_step(dependency, steps, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id.to_owned());
    Ok(())
}

fn normalize_steps(
    request: &ReleaseActivationRequest,
) -> ContractResult<Vec<ReleaseActivationPlanStep>> {
    if request.steps.is_empty() {
        return Err(fault(
            "invalid-release-activation-plan",
            "$/steps",
            "release activation requires at least one step",
        ));
    }
    let mut steps = BTreeMap::new();
    let mut operation_roots = BTreeSet::new();
    for (index, step) in request.steps.iter().enumerate() {
        if !ascii_token(&step.id) {
            return Err(fault(
                "invalid-release-activation-token",
                &format!("$/steps/{index}/id"),
                "activation step id must be an ASCII token",
            ));
        }
        step.operation.validate()?;
        validate_root(
            &step.compensation_boundary_root,
            &format!("$/steps/{index}/compensationBoundaryRoot"),
        )?;
        if step.operation.transaction_root != request.transaction_root
            || step.operation.authority_root != request.authority_root
            || step.operation.policy_root != request.policy_root
        {
            return Err(fault(
                "release-activation-authority-mismatch",
                &format!("$/steps/{index}/operation"),
                "step operation coordinates must match the activation request",
            ));
        }
        let operation_root = step.operation.root()?;
        if !operation_roots.insert(operation_root.clone()) {
            return Err(fault(
                "conflicting-release-activation-operation",
                "$/steps",
                "one logical operation cannot belong to multiple steps",
            ));
        }
        let dependencies =
            normalize_values(&step.dependencies, &format!("$/steps/{index}/dependencies"))?;
        let payload = PlanStepPayload {
            id: &step.id,
            dependencies: &dependencies,
            operation: &step.operation,
            operation_root: &operation_root,
            compensation_boundary_root: &step.compensation_boundary_root,
        };
        let step_root = content_root(
            "release-activation-step",
            &serde_json::to_value(payload)
                .map_err(|error| fault("canonicalization-failed", "$/steps", error.to_string()))?,
        )?;
        let normalized = ReleaseActivationPlanStep {
            id: step.id.clone(),
            dependencies,
            operation: step.operation.clone(),
            operation_root,
            compensation_boundary_root: step.compensation_boundary_root.clone(),
            step_root,
        };
        if steps.insert(step.id.clone(), normalized).is_some() {
            return Err(fault(
                "duplicate-release-activation-step",
                "$/steps",
                "activation step ids must be unique",
            ));
        }
    }
    for step in steps.values() {
        for dependency in &step.dependencies {
            if dependency == &step.id || !steps.contains_key(dependency) {
                return Err(fault(
                    "invalid-release-activation-dependency",
                    &format!("$/steps/{}/dependencies", step.id),
                    "dependencies must name another declared activation step",
                ));
            }
        }
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in steps.keys() {
        visit_step(id, &steps, &mut visiting, &mut visited)?;
    }
    Ok(steps.into_values().collect())
}

fn normalize_event(
    mut event: ReleaseActivationEvent,
    steps: &BTreeMap<String, ReleaseActivationPlanStep>,
    index: usize,
) -> ContractResult<ReleaseActivationEvent> {
    let path = format!("$/events/{index}");
    if !ascii_token(event.step_id()) || !steps.contains_key(event.step_id()) {
        return Err(fault(
            "invalid-release-activation-event",
            &format!("{path}/stepId"),
            "event must name a declared activation step",
        ));
    }
    if event.ordinal() == 0 || event.ordinal() > MAX_SAFE_INTEGER as u64 {
        return Err(fault(
            "invalid-release-activation-ordinal",
            &format!("{path}/ordinal"),
            "event ordinal must be a positive safe integer",
        ));
    }
    match &mut event {
        ReleaseActivationEvent::Attempt {
            attempted_at,
            effect_root,
            ..
        } => {
            validate_clock(attempted_at, &format!("{path}/attemptedAt"))?;
            validate_root(effect_root, &format!("{path}/effectRoot"))?;
        }
        ReleaseActivationEvent::Observation {
            observed_at,
            status,
            evidence_roots,
            ..
        } => {
            validate_clock(observed_at, &format!("{path}/observedAt"))?;
            if !["succeeded", "failed", "unknown"].contains(&status.as_str()) {
                return Err(fault(
                    "invalid-release-activation-observation",
                    &format!("{path}/status"),
                    "observation status is unsupported",
                ));
            }
            *evidence_roots = normalize_roots(evidence_roots, &format!("{path}/evidenceRoots"))?;
        }
        ReleaseActivationEvent::Reconciliation {
            reconciled_at,
            disposition,
            authority_root,
            ..
        } => {
            validate_clock(reconciled_at, &format!("{path}/reconciledAt"))?;
            validate_root(authority_root, &format!("{path}/authorityRoot"))?;
            if !["retry", "confirm", "terminal"].contains(&disposition.as_str()) {
                return Err(fault(
                    "invalid-release-activation-reconciliation",
                    &format!("{path}/disposition"),
                    "reconciliation disposition is unsupported",
                ));
            }
        }
        ReleaseActivationEvent::Confirmation {
            confirmed_at,
            outcome,
            authority_root,
            ..
        } => {
            validate_clock(confirmed_at, &format!("{path}/confirmedAt"))?;
            validate_root(authority_root, &format!("{path}/authorityRoot"))?;
            if !["confirmed", "rejected"].contains(&outcome.as_str()) {
                return Err(fault(
                    "invalid-release-activation-confirmation",
                    &format!("{path}/outcome"),
                    "confirmation outcome is unsupported",
                ));
            }
        }
    }
    if let ReleaseActivationEvent::Reconciliation { authority_root, .. }
    | ReleaseActivationEvent::Confirmation { authority_root, .. } = &event
        && authority_root != &steps[event.step_id()].operation.authority_root
    {
        return Err(fault(
            "release-activation-authority-mismatch",
            &format!("{path}/authorityRoot"),
            "journal authority cannot differ from planned authority",
        ));
    }
    Ok(event)
}

fn normalize_events(
    request: &ReleaseActivationRequest,
    steps: &BTreeMap<String, ReleaseActivationPlanStep>,
) -> ContractResult<Vec<ReleaseActivationEvent>> {
    let mut unique = BTreeMap::new();
    for (index, event) in request.events.iter().cloned().enumerate() {
        let normalized = normalize_event(event, steps, index)?;
        let key = (normalized.step_id().to_owned(), normalized.ordinal());
        if let Some(retained) = unique.get(&key) {
            if retained != &normalized {
                return Err(fault(
                    "conflicting-release-activation-event",
                    &format!("$/events/{index}"),
                    "one step ordinal cannot carry conflicting journal facts",
                ));
            }
        } else {
            unique.insert(key, normalized);
        }
    }
    let events = unique.into_values().collect::<Vec<_>>();
    let mut expected = BTreeMap::new();
    for event in &events {
        let ordinal = expected.entry(event.step_id()).or_insert(0_u64);
        *ordinal += 1;
        if event.ordinal() != *ordinal {
            return Err(fault(
                "release-activation-event-gap",
                &format!("$/events/{}/{}", event.step_id(), event.ordinal()),
                "deduplicated event ordinals must be contiguous per step",
            ));
        }
    }
    Ok(events)
}

fn plan(request: &ReleaseActivationRequest) -> ContractResult<ReleaseActivationPlan> {
    if request.schema != RELEASE_ACTIVATION_REQUEST_CONTRACT {
        return Err(fault(
            "unsupported-release-activation-version",
            "$/schema",
            "unsupported release activation request schema",
        ));
    }
    validate_clock(&request.declared_at, "$/declaredAt")?;
    validate_root(&request.transaction_root, "$/transactionRoot")?;
    let qualification_root = request.qualification_root.as_deref().ok_or_else(|| {
        fault(
            "missing-release-activation-qualification",
            "$/qualificationRoot",
            "release activation requires an explicit qualification root",
        )
    })?;
    validate_root(qualification_root, "$/qualificationRoot")?;
    validate_root(&request.authority_root, "$/authorityRoot")?;
    validate_root(&request.policy_root, "$/policyRoot")?;
    let steps = normalize_steps(request)?;
    let mut result = ReleaseActivationPlan {
        schema: RELEASE_ACTIVATION_PLAN_CONTRACT.to_owned(),
        mode: "shadow-only".to_owned(),
        production_authority: "v3".to_owned(),
        declared_at: request.declared_at.clone(),
        transaction_root: request.transaction_root.clone(),
        qualification_root: qualification_root.to_owned(),
        authority_root: request.authority_root.clone(),
        policy_root: request.policy_root.clone(),
        steps,
        plan_root: String::new(),
    };
    let payload = PlanPayload {
        schema: &result.schema,
        mode: &result.mode,
        production_authority: &result.production_authority,
        declared_at: &result.declared_at,
        transaction_root: &result.transaction_root,
        qualification_root: &result.qualification_root,
        authority_root: &result.authority_root,
        policy_root: &result.policy_root,
        steps: &result.steps,
    };
    result.plan_root = content_root(
        "release-activation-plan",
        &serde_json::to_value(payload)
            .map_err(|error| fault("canonicalization-failed", "$/plan", error.to_string()))?,
    )?;
    Ok(result)
}

pub fn project_release_activation(
    request: &ReleaseActivationRequest,
) -> ContractResult<ReleaseActivationProjection> {
    let plan = plan(request)?;
    let step_map = plan
        .steps
        .iter()
        .cloned()
        .map(|step| (step.id.clone(), step))
        .collect::<BTreeMap<_, _>>();
    let normalized_events = normalize_events(request, &step_map)?;
    let mut events = BTreeMap::<String, Vec<ReleaseActivationEvent>>::new();
    for event in normalized_events {
        events
            .entry(event.step_id().to_owned())
            .or_default()
            .push(event);
    }
    let mut confirmed = BTreeSet::new();
    let mut failed_steps = Vec::new();
    let mut readback_steps = Vec::new();
    let mut step_states = Vec::new();
    for step in &plan.steps {
        let retained = events.get(step.id.as_str()).cloned().unwrap_or_default();
        if retained.is_empty() {
            step_states.push(ReleaseActivationStepState {
                step_id: step.id.clone(),
                operation_root: step.operation_root.clone(),
                phase: "planned".to_owned(),
                journal_root: None,
                journal_state_root: None,
                entry_count: 0,
                attempt_count: 0,
                confirmation_root: None,
            });
            continue;
        }
        let entries = materialize_journal(request, step, &retained)?;
        let journal = fold_provider_operation_journal(&entries)?;
        if journal.phase == "confirmed" {
            confirmed.insert(step.id.clone());
        }
        if ["rejected", "terminal"].contains(&journal.phase.as_str()) {
            failed_steps.push(step.id.clone());
        }
        if ["attempting", "observed", "confirmable"].contains(&journal.phase.as_str()) {
            readback_steps.push(step.id.clone());
        }
        let journal_root = content_root(
            "provider-operation-journal",
            &serde_json::to_value(&entries).map_err(|error| {
                fault("canonicalization-failed", "$/journal", error.to_string())
            })?,
        )?;
        step_states.push(ReleaseActivationStepState {
            step_id: step.id.clone(),
            operation_root: step.operation_root.clone(),
            phase: journal.phase.clone(),
            journal_root: Some(journal_root),
            journal_state_root: Some(journal.root()?),
            entry_count: journal.entry_count,
            attempt_count: journal.attempt_count,
            confirmation_root: journal.confirmation_root,
        });
    }
    let eligible_steps = if failed_steps.is_empty() {
        plan.steps
            .iter()
            .zip(&step_states)
            .filter(|(step, state)| {
                ["planned", "intended", "retryable"].contains(&state.phase.as_str())
                    && step
                        .dependencies
                        .iter()
                        .all(|dependency| confirmed.contains(dependency))
            })
            .map(|(step, _)| step.id.clone())
            .collect()
    } else {
        Vec::new()
    };
    let confirmed_steps = confirmed.into_iter().collect::<Vec<_>>();
    let phase = if !failed_steps.is_empty() {
        "blocked"
    } else if confirmed_steps.len() == plan.steps.len() {
        "complete"
    } else {
        "active"
    };
    let mut state = ReleaseActivationState {
        schema: RELEASE_ACTIVATION_STATE_CONTRACT.to_owned(),
        mode: "shadow-only".to_owned(),
        production_authority: "v3".to_owned(),
        plan_root: plan.plan_root.clone(),
        phase: phase.to_owned(),
        step_states,
        confirmed_steps,
        failed_steps,
        readback_steps,
        eligible_steps,
        state_root: String::new(),
    };
    let payload = StatePayload {
        schema: &state.schema,
        mode: &state.mode,
        production_authority: &state.production_authority,
        plan_root: &state.plan_root,
        phase: &state.phase,
        step_states: &state.step_states,
        confirmed_steps: &state.confirmed_steps,
        failed_steps: &state.failed_steps,
        readback_steps: &state.readback_steps,
        eligible_steps: &state.eligible_steps,
    };
    state.state_root = content_root(
        "release-activation-state",
        &serde_json::to_value(payload)
            .map_err(|error| fault("canonicalization-failed", "$/state", error.to_string()))?,
    )?;
    Ok(ReleaseActivationProjection { plan, state })
}

pub fn project_release_activation_bytes(
    bytes: &[u8],
) -> ContractResult<ReleaseActivationProjection> {
    let request: ReleaseActivationRequest = serde_json::from_slice(bytes)
        .map_err(|error| fault("invalid-release-activation-request", "$", error.to_string()))?;
    project_release_activation(&request)
}
