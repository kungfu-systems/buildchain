use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    ContractFault, ContractResult, MAX_SAFE_INTEGER, ascii_token, content_root, validate_clock,
    validate_root,
};

pub const PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT: &str =
    "buildchain-v4-partial-mutation-recovery-request/v1";
pub const PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT: &str =
    "buildchain-v4-partial-mutation-recovery-plan/v1";
const STAGE_RESUME_EVIDENCE_CONTRACT: &str = "buildchain-v4-stage-capsule-resume-evidence/v1";
const ACTIVATION_RECOVERY_EVIDENCE_CONTRACT: &str =
    "buildchain-v4-release-activation-recovery-evidence/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn validate_token(value: &str, path: &str) -> ContractResult<()> {
    if !ascii_token(value) {
        return Err(fault(
            "invalid-partial-mutation-recovery-token",
            path,
            "recovery identifiers must be ASCII tokens",
        ));
    }
    Ok(())
}

fn validate_sorted_roots(values: &[String], path: &str) -> ContractResult<()> {
    let mut prior: Option<&str> = None;
    for (index, value) in values.iter().enumerate() {
        validate_root(value, &format!("{path}/{index}"))?;
        if prior.is_some_and(|root| value.as_str() <= root) {
            return Err(fault(
                "unordered-partial-mutation-recovery-evidence",
                &format!("{path}/{index}"),
                "values must be unique and byte-sorted",
            ));
        }
        prior = Some(value);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageRecoveryDecision {
    pub stage_key: String,
    pub decision: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageResumeEvidence {
    pub schema: String,
    pub plan_root: String,
    pub source_root: String,
    pub policy_root: String,
    pub platform_root: String,
    pub qualification_roots: Vec<String>,
    pub decisions: Vec<StageRecoveryDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRecoveryStep {
    pub step_id: String,
    pub operation_root: String,
    pub phase: String,
    pub journal_root: Option<String>,
    pub journal_state_root: Option<String>,
    pub compensation_boundary_root: String,
    pub attempt_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRecoveryEvidence {
    pub schema: String,
    pub plan_root: String,
    pub state_root: String,
    pub qualification_root: String,
    pub policy_root: String,
    pub steps: Vec<ActivationRecoveryStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartialMutationRecoveryRequest {
    pub schema: String,
    pub evaluated_at: String,
    pub source_root: String,
    pub policy_root: String,
    pub platform_root: String,
    pub qualification_root: String,
    pub max_attempts: u64,
    pub compensable_boundary_roots: Vec<String>,
    pub stage_resume: StageResumeEvidence,
    pub activation: ActivationRecoveryEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCheckpoint {
    pub kind: String,
    pub id: String,
    pub root: String,
    pub checkpoint_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNextOperation {
    pub step_id: String,
    pub operation_root: Option<String>,
    pub action: String,
    pub checkpoint: RecoveryCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryComplexity {
    pub stage_decision_count: usize,
    pub operation_count: usize,
    pub next_operation_count: usize,
    pub external_mutation_count: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialMutationRecoveryPlan {
    pub schema: String,
    pub mode: String,
    pub production_authority: String,
    pub evaluated_at: String,
    pub source_root: String,
    pub policy_root: String,
    pub platform_root: String,
    pub qualification_root: String,
    pub stage_resume_plan_root: String,
    pub activation_plan_root: String,
    pub activation_state_root: String,
    pub classification: String,
    pub unresolved_checkpoint: Option<RecoveryCheckpoint>,
    pub next_operations: Vec<RecoveryNextOperation>,
    pub terminal_operation_roots: Vec<String>,
    pub zero_external_mutations: bool,
    pub complexity: RecoveryComplexity,
    pub plan_root: String,
}

impl PartialMutationRecoveryRequest {
    fn validate(&self) -> ContractResult<()> {
        if self.schema != PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT {
            return Err(fault(
                "unsupported-partial-mutation-recovery-version",
                "$/schema",
                "unsupported partial-mutation recovery request",
            ));
        }
        validate_clock(&self.evaluated_at, "$/evaluatedAt")?;
        for (value, path) in [
            (&self.source_root, "$/sourceRoot"),
            (&self.policy_root, "$/policyRoot"),
            (&self.platform_root, "$/platformRoot"),
            (&self.qualification_root, "$/qualificationRoot"),
        ] {
            validate_root(value, path)?;
        }
        if self.max_attempts == 0 || self.max_attempts > MAX_SAFE_INTEGER as u64 {
            return Err(fault(
                "invalid-partial-mutation-recovery-attempt-budget",
                "$/maxAttempts",
                "maxAttempts must be a positive safe integer",
            ));
        }
        validate_sorted_roots(
            &self.compensable_boundary_roots,
            "$/compensableBoundaryRoots",
        )?;
        self.validate_stage_resume()?;
        self.validate_activation()?;
        Ok(())
    }

    fn validate_stage_resume(&self) -> ContractResult<()> {
        let evidence = &self.stage_resume;
        if evidence.schema != STAGE_RESUME_EVIDENCE_CONTRACT {
            return Err(fault(
                "unsupported-partial-mutation-recovery-version",
                "$/stageResume/schema",
                "unsupported Stage Capsule resume evidence",
            ));
        }
        validate_root(&evidence.plan_root, "$/stageResume/planRoot")?;
        for (value, expected, path) in [
            (
                &evidence.source_root,
                &self.source_root,
                "$/stageResume/sourceRoot",
            ),
            (
                &evidence.policy_root,
                &self.policy_root,
                "$/stageResume/policyRoot",
            ),
            (
                &evidence.platform_root,
                &self.platform_root,
                "$/stageResume/platformRoot",
            ),
        ] {
            validate_root(value, path)?;
            if value != expected {
                return Err(fault(
                    "partial-mutation-recovery-binding-mismatch",
                    path,
                    "Stage Capsule evidence drifted from the recovery request",
                ));
            }
        }
        validate_sorted_roots(
            &evidence.qualification_roots,
            "$/stageResume/qualificationRoots",
        )?;
        if evidence.qualification_roots.is_empty() || evidence.decisions.is_empty() {
            return Err(fault(
                "missing-partial-mutation-recovery-evidence",
                "$/stageResume",
                "Stage Capsule qualifications and decisions are required",
            ));
        }
        let mut prior: Option<&str> = None;
        for (index, decision) in evidence.decisions.iter().enumerate() {
            let path = format!("$/stageResume/decisions/{index}");
            validate_token(&decision.stage_key, &format!("{path}/stageKey"))?;
            validate_token(&decision.reason_code, &format!("{path}/reasonCode"))?;
            if !matches!(decision.decision.as_str(), "reuse" | "rebuild" | "reject") {
                return Err(fault(
                    "invalid-partial-mutation-recovery-stage-decision",
                    &format!("{path}/decision"),
                    "unsupported Stage Capsule decision",
                ));
            }
            if prior.is_some_and(|value| decision.stage_key.as_str() <= value) {
                return Err(fault(
                    "unordered-partial-mutation-recovery-evidence",
                    &format!("{path}/stageKey"),
                    "stage decisions must be unique and byte-sorted",
                ));
            }
            prior = Some(&decision.stage_key);
        }
        Ok(())
    }

    fn validate_activation(&self) -> ContractResult<()> {
        let evidence = &self.activation;
        if evidence.schema != ACTIVATION_RECOVERY_EVIDENCE_CONTRACT {
            return Err(fault(
                "unsupported-partial-mutation-recovery-version",
                "$/activation/schema",
                "unsupported release activation evidence",
            ));
        }
        for (value, path) in [
            (&evidence.plan_root, "$/activation/planRoot"),
            (&evidence.state_root, "$/activation/stateRoot"),
            (
                &evidence.qualification_root,
                "$/activation/qualificationRoot",
            ),
            (&evidence.policy_root, "$/activation/policyRoot"),
        ] {
            validate_root(value, path)?;
        }
        if evidence.qualification_root != self.qualification_root
            || evidence.policy_root != self.policy_root
        {
            return Err(fault(
                "partial-mutation-recovery-binding-mismatch",
                "$/activation",
                "activation qualification or policy root drifted",
            ));
        }
        if evidence.steps.is_empty() {
            return Err(fault(
                "missing-partial-mutation-recovery-evidence",
                "$/activation/steps",
                "activation steps are required",
            ));
        }
        let mut prior: Option<&str> = None;
        let mut operation_roots = BTreeSet::new();
        for (index, step) in evidence.steps.iter().enumerate() {
            let path = format!("$/activation/steps/{index}");
            validate_token(&step.step_id, &format!("{path}/stepId"))?;
            validate_root(&step.operation_root, &format!("{path}/operationRoot"))?;
            if !operation_roots.insert(&step.operation_root) {
                return Err(fault(
                    "conflicting-partial-mutation-recovery-evidence",
                    &format!("{path}/operationRoot"),
                    "activation steps must bind unique provider operations",
                ));
            }
            validate_root(
                &step.compensation_boundary_root,
                &format!("{path}/compensationBoundaryRoot"),
            )?;
            if !matches!(
                step.phase.as_str(),
                "planned"
                    | "intended"
                    | "attempting"
                    | "observed"
                    | "confirmable"
                    | "retryable"
                    | "confirmed"
                    | "rejected"
                    | "terminal"
            ) {
                return Err(fault(
                    "unknown-partial-mutation-recovery-phase",
                    &format!("{path}/phase"),
                    "operation phase is not in the closed recovery state set",
                ));
            }
            if step.attempt_count > MAX_SAFE_INTEGER as u64 {
                return Err(fault(
                    "invalid-partial-mutation-recovery-attempt-count",
                    &format!("{path}/attemptCount"),
                    "attempt count must be a safe integer",
                ));
            }
            if step.phase == "planned" {
                if step.journal_root.is_some() || step.journal_state_root.is_some() {
                    return Err(fault(
                        "conflicting-partial-mutation-recovery-evidence",
                        &format!("{path}/journalRoot"),
                        "planned operations cannot claim retained journal roots",
                    ));
                }
            } else {
                validate_root(
                    step.journal_root.as_deref().unwrap_or(""),
                    &format!("{path}/journalRoot"),
                )?;
                validate_root(
                    step.journal_state_root.as_deref().unwrap_or(""),
                    &format!("{path}/journalStateRoot"),
                )?;
            }
            if step.phase == "attempting" && step.attempt_count == 0 {
                return Err(fault(
                    "conflicting-partial-mutation-recovery-evidence",
                    &format!("{path}/attemptCount"),
                    "attempting requires a retained attempt",
                ));
            }
            if prior.is_some_and(|value| step.step_id.as_str() <= value) {
                return Err(fault(
                    "unordered-partial-mutation-recovery-evidence",
                    &format!("{path}/stepId"),
                    "activation steps must be unique and byte-sorted",
                ));
            }
            prior = Some(&step.step_id);
        }
        Ok(())
    }
}

fn checkpoint(kind: &str, id: &str, root: &str) -> ContractResult<RecoveryCheckpoint> {
    let payload = json!({ "kind": kind, "id": id, "root": root });
    Ok(RecoveryCheckpoint {
        kind: kind.to_owned(),
        id: id.to_owned(),
        root: root.to_owned(),
        checkpoint_root: content_root("partial-mutation-recovery-checkpoint", &payload)?,
    })
}

fn action_priority(value: &str) -> usize {
    match value {
        "escalate" => 0,
        "compensate" => 1,
        "reconcile" => 2,
        "wait" => 3,
        "retry" => 4,
        _ => 5,
    }
}

fn operation_decision(
    step: &ActivationRecoveryStep,
    request: &PartialMutationRecoveryRequest,
) -> ContractResult<Option<RecoveryNextOperation>> {
    if step.phase == "confirmed" {
        return Ok(None);
    }
    let compensable = request
        .compensable_boundary_roots
        .binary_search(&step.compensation_boundary_root)
        .is_ok();
    let action = if matches!(step.phase.as_str(), "rejected" | "terminal") {
        if compensable {
            "compensate"
        } else {
            "escalate"
        }
    } else if step.attempt_count >= request.max_attempts {
        "escalate"
    } else if matches!(step.phase.as_str(), "observed" | "confirmable") {
        "reconcile"
    } else if step.phase == "attempting" {
        "wait"
    } else {
        "retry"
    };
    let retained_root = step
        .journal_state_root
        .as_deref()
        .unwrap_or(&step.operation_root);
    Ok(Some(RecoveryNextOperation {
        step_id: step.step_id.clone(),
        operation_root: Some(step.operation_root.clone()),
        action: action.to_owned(),
        checkpoint: checkpoint("provider-operation", &step.step_id, retained_root)?,
    }))
}

pub fn plan_partial_mutation_recovery(
    request: &PartialMutationRecoveryRequest,
) -> ContractResult<PartialMutationRecoveryPlan> {
    request.validate()?;
    let stage_failure = request
        .stage_resume
        .decisions
        .iter()
        .find(|decision| decision.decision != "reuse");
    let mut next_operations = if let Some(stage) = stage_failure {
        vec![RecoveryNextOperation {
            step_id: stage.stage_key.clone(),
            operation_root: None,
            action: "escalate".to_owned(),
            checkpoint: checkpoint(
                "stage-capsule",
                &stage.stage_key,
                &request.stage_resume.plan_root,
            )?,
        }]
    } else {
        request
            .activation
            .steps
            .iter()
            .map(|step| operation_decision(step, request))
            .collect::<ContractResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    };
    next_operations.sort_by(|left, right| {
        action_priority(&left.action)
            .cmp(&action_priority(&right.action))
            .then_with(|| left.step_id.cmp(&right.step_id))
    });
    let classification = next_operations
        .first()
        .map(|operation| operation.action.clone())
        .unwrap_or_else(|| "terminal-noop".to_owned());
    let mut terminal_operation_roots = request
        .activation
        .steps
        .iter()
        .filter(|step| step.phase == "confirmed")
        .map(|step| step.operation_root.clone())
        .collect::<Vec<_>>();
    terminal_operation_roots.sort();
    let complexity = RecoveryComplexity {
        stage_decision_count: request.stage_resume.decisions.len(),
        operation_count: request.activation.steps.len(),
        next_operation_count: next_operations.len(),
        external_mutation_count: 0,
    };
    let unresolved_checkpoint = next_operations
        .first()
        .map(|operation| operation.checkpoint.clone());
    let payload = json!({
        "schema": PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT,
        "mode": "shadow-only",
        "productionAuthority": "v3",
        "evaluatedAt": request.evaluated_at,
        "sourceRoot": request.source_root,
        "policyRoot": request.policy_root,
        "platformRoot": request.platform_root,
        "qualificationRoot": request.qualification_root,
        "stageResumePlanRoot": request.stage_resume.plan_root,
        "activationPlanRoot": request.activation.plan_root,
        "activationStateRoot": request.activation.state_root,
        "classification": classification,
        "unresolvedCheckpoint": unresolved_checkpoint,
        "nextOperations": next_operations,
        "terminalOperationRoots": terminal_operation_roots,
        "zeroExternalMutations": true,
        "complexity": complexity,
    });
    Ok(PartialMutationRecoveryPlan {
        schema: PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT.to_owned(),
        mode: "shadow-only".to_owned(),
        production_authority: "v3".to_owned(),
        evaluated_at: request.evaluated_at.clone(),
        source_root: request.source_root.clone(),
        policy_root: request.policy_root.clone(),
        platform_root: request.platform_root.clone(),
        qualification_root: request.qualification_root.clone(),
        stage_resume_plan_root: request.stage_resume.plan_root.clone(),
        activation_plan_root: request.activation.plan_root.clone(),
        activation_state_root: request.activation.state_root.clone(),
        classification,
        unresolved_checkpoint,
        next_operations,
        terminal_operation_roots,
        zero_external_mutations: true,
        complexity,
        plan_root: content_root("partial-mutation-recovery-plan", &payload)?,
    })
}

pub fn plan_partial_mutation_recovery_bytes(
    bytes: &[u8],
) -> ContractResult<PartialMutationRecoveryPlan> {
    let request: PartialMutationRecoveryRequest =
        serde_json::from_slice(bytes).map_err(|error| {
            fault(
                "invalid-partial-mutation-recovery-request",
                "$",
                error.to_string(),
            )
        })?;
    plan_partial_mutation_recovery(&request)
}
