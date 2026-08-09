use serde::{Deserialize, Serialize};

use crate::provider_operation_journal::ProviderOperationIdentity;

pub const RELEASE_ACTIVATION_REQUEST_CONTRACT: &str = "buildchain-v4-release-activation-request/v1";
pub const RELEASE_ACTIVATION_PLAN_CONTRACT: &str = "buildchain-v4-release-activation-plan/v1";
pub const RELEASE_ACTIVATION_STATE_CONTRACT: &str = "buildchain-v4-release-activation-state/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseActivationStep {
    pub id: String,
    pub dependencies: Vec<String>,
    pub operation: ProviderOperationIdentity,
    pub compensation_boundary_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReleaseActivationEvent {
    Attempt {
        step_id: String,
        ordinal: u64,
        attempted_at: String,
        effect_root: String,
    },
    Observation {
        step_id: String,
        ordinal: u64,
        observed_at: String,
        status: String,
        evidence_roots: Vec<String>,
    },
    Reconciliation {
        step_id: String,
        ordinal: u64,
        reconciled_at: String,
        disposition: String,
        authority_root: String,
    },
    Confirmation {
        step_id: String,
        ordinal: u64,
        confirmed_at: String,
        outcome: String,
        authority_root: String,
    },
}

impl ReleaseActivationEvent {
    pub(super) fn step_id(&self) -> &str {
        match self {
            Self::Attempt { step_id, .. }
            | Self::Observation { step_id, .. }
            | Self::Reconciliation { step_id, .. }
            | Self::Confirmation { step_id, .. } => step_id,
        }
    }

    pub(super) fn ordinal(&self) -> u64 {
        match self {
            Self::Attempt { ordinal, .. }
            | Self::Observation { ordinal, .. }
            | Self::Reconciliation { ordinal, .. }
            | Self::Confirmation { ordinal, .. } => *ordinal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseActivationRequest {
    pub schema: String,
    pub declared_at: String,
    pub transaction_root: String,
    pub qualification_root: Option<String>,
    pub authority_root: String,
    pub policy_root: String,
    pub steps: Vec<ReleaseActivationStep>,
    pub events: Vec<ReleaseActivationEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActivationPlanStep {
    pub id: String,
    pub dependencies: Vec<String>,
    pub operation: ProviderOperationIdentity,
    pub operation_root: String,
    pub compensation_boundary_root: String,
    pub step_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActivationPlan {
    pub schema: String,
    pub mode: String,
    pub production_authority: String,
    pub declared_at: String,
    pub transaction_root: String,
    pub qualification_root: String,
    pub authority_root: String,
    pub policy_root: String,
    pub steps: Vec<ReleaseActivationPlanStep>,
    pub plan_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActivationStepState {
    pub step_id: String,
    pub operation_root: String,
    pub phase: String,
    pub journal_root: Option<String>,
    pub journal_state_root: Option<String>,
    pub entry_count: u64,
    pub attempt_count: u64,
    pub confirmation_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseActivationState {
    pub schema: String,
    pub mode: String,
    pub production_authority: String,
    pub plan_root: String,
    pub phase: String,
    pub step_states: Vec<ReleaseActivationStepState>,
    pub confirmed_steps: Vec<String>,
    pub failed_steps: Vec<String>,
    pub readback_steps: Vec<String>,
    pub eligible_steps: Vec<String>,
    pub state_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseActivationProjection {
    pub plan: ReleaseActivationPlan,
    pub state: ReleaseActivationState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanStepPayload<'a> {
    pub(super) id: &'a str,
    pub(super) dependencies: &'a [String],
    pub(super) operation: &'a ProviderOperationIdentity,
    pub(super) operation_root: &'a str,
    pub(super) compensation_boundary_root: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanPayload<'a> {
    pub(super) schema: &'a str,
    pub(super) mode: &'a str,
    pub(super) production_authority: &'a str,
    pub(super) declared_at: &'a str,
    pub(super) transaction_root: &'a str,
    pub(super) qualification_root: &'a str,
    pub(super) authority_root: &'a str,
    pub(super) policy_root: &'a str,
    pub(super) steps: &'a [ReleaseActivationPlanStep],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatePayload<'a> {
    pub(super) schema: &'a str,
    pub(super) mode: &'a str,
    pub(super) production_authority: &'a str,
    pub(super) plan_root: &'a str,
    pub(super) phase: &'a str,
    pub(super) step_states: &'a [ReleaseActivationStepState],
    pub(super) confirmed_steps: &'a [String],
    pub(super) failed_steps: &'a [String],
    pub(super) readback_steps: &'a [String],
    pub(super) eligible_steps: &'a [String],
}
