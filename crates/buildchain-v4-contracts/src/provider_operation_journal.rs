use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ContractFault, ContractResult, MAX_SAFE_INTEGER, ascii_token, content_root, validate_clock,
    validate_root,
};

mod fold;
pub use fold::{ProviderOperationJournalState, fold_provider_operation_journal};

pub const PROVIDER_OPERATION_IDENTITY_CONTRACT: &str =
    "buildchain-v4-provider-operation-identity/v1";
const PROVIDER_OPERATION_INTENT_CONTRACT: &str = "buildchain-v4-provider-operation-intent/v1";
const PROVIDER_OPERATION_ATTEMPT_CONTRACT: &str = "buildchain-v4-provider-operation-attempt/v1";
const PROVIDER_OPERATION_OBSERVATION_CONTRACT: &str =
    "buildchain-v4-provider-operation-observation/v1";
const PROVIDER_OPERATION_CONFIRMATION_CONTRACT: &str =
    "buildchain-v4-provider-operation-confirmation/v1";
const PROVIDER_OPERATION_RECONCILIATION_CONTRACT: &str =
    "buildchain-v4-provider-operation-reconciliation/v1";
const PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT: &str =
    "buildchain-v4-provider-operation-journal-state/v1";
const PROVIDER_OPERATION_FIXTURE_CONTRACT: &str =
    "buildchain-v4-provider-operation-journal-fixtures/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationIdentity {
    pub schema: String,
    pub transaction_root: String,
    pub capability_id: String,
    pub subject_root: String,
    pub target_root: String,
    pub authority_root: String,
    pub policy_root: String,
}

impl ProviderOperationIdentity {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != PROVIDER_OPERATION_IDENTITY_CONTRACT {
            return Err(fault(
                "unsupported-provider-operation-version",
                "$/operation/schema",
                "unsupported provider operation identity schema",
            ));
        }
        if self.capability_id.split('.').any(|part| !ascii_token(part)) {
            return Err(fault(
                "invalid-provider-operation-token",
                "$/operation/capabilityId",
                "capabilityId must be an ASCII dotted token",
            ));
        }
        for (value, path) in [
            (&self.transaction_root, "$/operation/transactionRoot"),
            (&self.subject_root, "$/operation/subjectRoot"),
            (&self.target_root, "$/operation/targetRoot"),
            (&self.authority_root, "$/operation/authorityRoot"),
            (&self.policy_root, "$/operation/policyRoot"),
        ] {
            validate_root(value, path)?;
        }
        Ok(())
    }

    pub fn root(&self) -> ContractResult<String> {
        self.validate()?;
        content_root(
            "provider-operation-identity",
            &serde_json::to_value(self).map_err(|error| {
                fault("canonicalization-failed", "$/operation", error.to_string())
            })?,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationIntent {
    pub schema: String,
    pub sequence: u64,
    pub prior_entry_root: Option<String>,
    pub operation: ProviderOperationIdentity,
    pub operation_root: String,
    pub declared_at: String,
    pub input_root: String,
    pub entry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationAttempt {
    pub schema: String,
    pub sequence: u64,
    pub prior_entry_root: Option<String>,
    pub operation_root: String,
    pub attempt_ordinal: u64,
    pub attempted_at: String,
    pub effect_root: String,
    pub entry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationObservation {
    pub schema: String,
    pub sequence: u64,
    pub prior_entry_root: Option<String>,
    pub operation_root: String,
    pub attempt_root: String,
    pub observed_at: String,
    pub status: String,
    pub evidence_roots: Vec<String>,
    pub entry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationConfirmation {
    pub schema: String,
    pub sequence: u64,
    pub prior_entry_root: Option<String>,
    pub operation_root: String,
    pub observation_root: String,
    pub authority_root: String,
    pub confirmed_at: String,
    pub outcome: String,
    pub entry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOperationReconciliation {
    pub schema: String,
    pub sequence: u64,
    pub prior_entry_root: Option<String>,
    pub operation_root: String,
    pub observation_root: String,
    pub authority_root: String,
    pub reconciled_at: String,
    pub disposition: String,
    pub entry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProviderOperationEntry {
    Intent(ProviderOperationIntent),
    Attempt(ProviderOperationAttempt),
    Observation(ProviderOperationObservation),
    Confirmation(ProviderOperationConfirmation),
    Reconciliation(ProviderOperationReconciliation),
}

impl ProviderOperationEntry {
    pub(super) fn sequence(&self) -> u64 {
        match self {
            Self::Intent(value) => value.sequence,
            Self::Attempt(value) => value.sequence,
            Self::Observation(value) => value.sequence,
            Self::Confirmation(value) => value.sequence,
            Self::Reconciliation(value) => value.sequence,
        }
    }

    pub(super) fn prior_entry_root(&self) -> Option<&str> {
        match self {
            Self::Intent(value) => value.prior_entry_root.as_deref(),
            Self::Attempt(value) => value.prior_entry_root.as_deref(),
            Self::Observation(value) => value.prior_entry_root.as_deref(),
            Self::Confirmation(value) => value.prior_entry_root.as_deref(),
            Self::Reconciliation(value) => value.prior_entry_root.as_deref(),
        }
    }

    pub(super) fn operation_root(&self) -> &str {
        match self {
            Self::Intent(value) => &value.operation_root,
            Self::Attempt(value) => &value.operation_root,
            Self::Observation(value) => &value.operation_root,
            Self::Confirmation(value) => &value.operation_root,
            Self::Reconciliation(value) => &value.operation_root,
        }
    }

    pub fn entry_root(&self) -> &str {
        match self {
            Self::Intent(value) => &value.entry_root,
            Self::Attempt(value) => &value.entry_root,
            Self::Observation(value) => &value.entry_root,
            Self::Confirmation(value) => &value.entry_root,
            Self::Reconciliation(value) => &value.entry_root,
        }
    }

    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Intent(_) => "intent",
            Self::Attempt(_) => "attempt",
            Self::Observation(_) => "observation",
            Self::Confirmation(_) => "confirmation",
            Self::Reconciliation(_) => "reconciliation",
        }
    }

    fn domain(&self) -> &'static str {
        match self {
            Self::Intent(_) => "provider-operation-intent",
            Self::Attempt(_) => "provider-operation-attempt",
            Self::Observation(_) => "provider-operation-observation",
            Self::Confirmation(_) => "provider-operation-confirmation",
            Self::Reconciliation(_) => "provider-operation-reconciliation",
        }
    }

    pub(crate) fn calculated_root(&self) -> ContractResult<String> {
        let mut value = serde_json::to_value(self)
            .map_err(|error| fault("canonicalization-failed", "$/entry", error.to_string()))?;
        value
            .as_object_mut()
            .ok_or_else(|| {
                fault(
                    "invalid-provider-operation-shape",
                    "$",
                    "entry must be an object",
                )
            })?
            .remove("entryRoot");
        content_root(self.domain(), &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.sequence() > MAX_SAFE_INTEGER as u64 {
            return Err(fault(
                "invalid-provider-operation-counter",
                "$/sequence",
                "sequence must be a canonical safe integer",
            ));
        }
        validate_root(self.operation_root(), "$/operationRoot")?;
        if let Some(root) = self.prior_entry_root() {
            validate_root(root, "$/priorEntryRoot")?;
        }
        match self {
            Self::Intent(value) => {
                if value.schema != PROVIDER_OPERATION_INTENT_CONTRACT {
                    return Err(fault(
                        "unsupported-provider-operation-version",
                        "$/schema",
                        "unsupported provider operation intent schema",
                    ));
                }
                value.operation.validate()?;
                validate_clock(&value.declared_at, "$/declaredAt")?;
                validate_root(&value.input_root, "$/inputRoot")?;
                if value.operation_root != value.operation.root()? {
                    return Err(fault(
                        "provider-operation-root-mismatch",
                        "$/operationRoot",
                        "operationRoot does not bind the logical provider operation",
                    ));
                }
            }
            Self::Attempt(value) => {
                if value.schema != PROVIDER_OPERATION_ATTEMPT_CONTRACT {
                    return Err(fault(
                        "unsupported-provider-operation-version",
                        "$/schema",
                        "unsupported provider operation attempt schema",
                    ));
                }
                if value.attempt_ordinal == 0 || value.attempt_ordinal > MAX_SAFE_INTEGER as u64 {
                    return Err(fault(
                        "invalid-provider-operation-counter",
                        "$/attemptOrdinal",
                        "attemptOrdinal must be greater than zero",
                    ));
                }
                validate_clock(&value.attempted_at, "$/attemptedAt")?;
                validate_root(&value.effect_root, "$/effectRoot")?;
            }
            Self::Observation(value) => {
                if value.schema != PROVIDER_OPERATION_OBSERVATION_CONTRACT {
                    return Err(fault(
                        "unsupported-provider-operation-version",
                        "$/schema",
                        "unsupported provider operation observation schema",
                    ));
                }
                validate_root(&value.attempt_root, "$/attemptRoot")?;
                validate_clock(&value.observed_at, "$/observedAt")?;
                if !["succeeded", "failed", "unknown"].contains(&value.status.as_str()) {
                    return Err(fault(
                        "invalid-provider-operation-observation",
                        "$/status",
                        "provider operation observation status is unsupported",
                    ));
                }
                validate_evidence_roots(&value.evidence_roots)?;
            }
            Self::Confirmation(value) => {
                if value.schema != PROVIDER_OPERATION_CONFIRMATION_CONTRACT {
                    return Err(fault(
                        "unsupported-provider-operation-version",
                        "$/schema",
                        "unsupported provider operation confirmation schema",
                    ));
                }
                validate_root(&value.observation_root, "$/observationRoot")?;
                validate_root(&value.authority_root, "$/authorityRoot")?;
                validate_clock(&value.confirmed_at, "$/confirmedAt")?;
                if !["confirmed", "rejected"].contains(&value.outcome.as_str()) {
                    return Err(fault(
                        "invalid-provider-operation-confirmation",
                        "$/outcome",
                        "provider operation confirmation outcome is unsupported",
                    ));
                }
            }
            Self::Reconciliation(value) => {
                if value.schema != PROVIDER_OPERATION_RECONCILIATION_CONTRACT {
                    return Err(fault(
                        "unsupported-provider-operation-version",
                        "$/schema",
                        "unsupported provider operation reconciliation schema",
                    ));
                }
                validate_root(&value.observation_root, "$/observationRoot")?;
                validate_root(&value.authority_root, "$/authorityRoot")?;
                validate_clock(&value.reconciled_at, "$/reconciledAt")?;
                if !["retry", "confirm", "terminal"].contains(&value.disposition.as_str()) {
                    return Err(fault(
                        "invalid-provider-operation-reconciliation",
                        "$/disposition",
                        "provider operation reconciliation disposition is unsupported",
                    ));
                }
            }
        }
        validate_root(self.entry_root(), "$/entryRoot")?;
        if self.entry_root() != self.calculated_root()? {
            return Err(fault(
                "provider-operation-entry-root-mismatch",
                "$/entryRoot",
                "entryRoot does not bind the canonical provider operation entry",
            ));
        }
        Ok(())
    }
}

fn validate_evidence_roots(roots: &[String]) -> ContractResult<()> {
    if roots.is_empty() {
        return Err(fault(
            "invalid-provider-operation-evidence",
            "$/evidenceRoots",
            "evidenceRoots must contain at least one rooted observation",
        ));
    }
    let mut prior: Option<&str> = None;
    for (index, root) in roots.iter().enumerate() {
        validate_root(root, &format!("$/evidenceRoots/{index}"))?;
        if prior.is_some_and(|value| root.as_str() <= value) {
            return Err(fault(
                "invalid-provider-operation-evidence",
                &format!("$/evidenceRoots/{index}"),
                "evidenceRoots must be unique and byte-sorted",
            ));
        }
        prior = Some(root);
    }
    Ok(())
}

fn journal_root(entries: &[ProviderOperationEntry]) -> ContractResult<String> {
    fold_provider_operation_journal(entries)?;
    content_root(
        "provider-operation-journal",
        &serde_json::to_value(entries)
            .map_err(|error| fault("canonicalization-failed", "$/entries", error.to_string()))?,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderOperationFixtures {
    schema_version: u64,
    contract: String,
    valid_cases: Vec<ProviderOperationFixtureCase>,
    invalid_cases: Vec<ProviderOperationFixtureCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderOperationFixtureCase {
    id: String,
    entries: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOperationValidProjection {
    id: String,
    operation_root: String,
    entry_roots: Vec<String>,
    journal_root: String,
    state: ProviderOperationJournalState,
    state_root: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderOperationInvalidProjection {
    id: String,
    fault: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOperationFixtureProjection {
    pub valid_cases: Vec<ProviderOperationValidProjection>,
    pub invalid_cases: Vec<ProviderOperationInvalidProjection>,
}

fn decode_entries(values: Vec<Value>) -> ContractResult<Vec<ProviderOperationEntry>> {
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                fault(
                    "invalid-provider-operation-shape",
                    "$",
                    format!("invalid closed provider operation shape: {error}"),
                )
            })
        })
        .collect()
}

pub fn run_provider_operation_journal_fixture(
    bytes: &[u8],
) -> ContractResult<ProviderOperationFixtureProjection> {
    let fixtures: ProviderOperationFixtures = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "invalid-provider-operation-fixture",
            "$",
            format!("invalid provider operation fixtures: {error}"),
        )
    })?;
    if fixtures.schema_version != 1 || fixtures.contract != PROVIDER_OPERATION_FIXTURE_CONTRACT {
        return Err(fault(
            "unsupported-provider-operation-version",
            "$/schemaVersion",
            "unsupported provider operation fixture contract",
        ));
    }
    let valid_cases = fixtures
        .valid_cases
        .into_iter()
        .map(|fixture| {
            let entries = decode_entries(fixture.entries)?;
            let state = fold_provider_operation_journal(&entries)?;
            Ok(ProviderOperationValidProjection {
                id: fixture.id,
                operation_root: state.operation_root.clone(),
                entry_roots: entries
                    .iter()
                    .map(|entry| entry.entry_root().to_owned())
                    .collect(),
                journal_root: journal_root(&entries)?,
                state_root: state.root()?,
                state,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    let invalid_cases = fixtures
        .invalid_cases
        .into_iter()
        .map(|fixture| {
            let error = decode_entries(fixture.entries)
                .and_then(|entries| fold_provider_operation_journal(&entries).map(|_| ()))
                .err()
                .ok_or_else(|| {
                    fault(
                        "invalid-provider-operation-fixture",
                        "$/invalidCases",
                        format!("fixture {} unexpectedly passed", fixture.id),
                    )
                })?;
            Ok(ProviderOperationInvalidProjection {
                id: fixture.id,
                fault: error.code,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    Ok(ProviderOperationFixtureProjection {
        valid_cases,
        invalid_cases,
    })
}
