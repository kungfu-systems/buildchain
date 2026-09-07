use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider_operation_journal::{
    ProviderOperationEntry, ProviderOperationObservation, fold_provider_operation_journal,
};
use crate::{
    ContractFault, ContractResult, MAX_SAFE_INTEGER, content_root, validate_clock, validate_root,
};

pub const PROVIDER_READBACK_SAMPLE_CONTRACT: &str = "buildchain-v4-provider-readback-sample/v1";
pub const PROVIDER_READBACK_FOLD_CONTRACT: &str = "buildchain-v4-provider-readback-fold/v1";
const PROVIDER_OPERATION_OBSERVATION_CONTRACT: &str =
    "buildchain-v4-provider-operation-observation/v1";
const PROVIDER_READBACK_FIXTURE_CONTRACT: &str =
    "buildchain-v4-provider-readback-idempotency-fixtures/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReadbackSample {
    pub schema: String,
    pub operation_root: String,
    pub attempt_root: String,
    pub state: String,
    pub observed_target_root: Option<String>,
    pub evidence_roots: Vec<String>,
    pub sample_root: String,
}

impl ProviderReadbackSample {
    fn calculated_root(&self) -> ContractResult<String> {
        let mut value = serde_json::to_value(self)
            .map_err(|error| fault("canonicalization-failed", "$/samples", error.to_string()))?;
        value
            .as_object_mut()
            .expect("serialized provider readback sample is an object")
            .remove("sampleRoot");
        content_root("provider-readback-sample", &value)
    }

    pub fn validate(&self, path: &str) -> ContractResult<()> {
        if self.schema != PROVIDER_READBACK_SAMPLE_CONTRACT {
            return Err(fault(
                "unsupported-provider-readback-version",
                &format!("{path}/schema"),
                "unsupported provider readback sample schema",
            ));
        }
        if !["not-found", "eventually-visible", "already-applied"].contains(&self.state.as_str()) {
            return Err(fault(
                "malformed-provider-readback",
                &format!("{path}/state"),
                "provider readback state is unsupported",
            ));
        }
        validate_root(&self.operation_root, &format!("{path}/operationRoot"))?;
        validate_root(&self.attempt_root, &format!("{path}/attemptRoot"))?;
        validate_root(&self.sample_root, &format!("{path}/sampleRoot"))?;
        if let Some(root) = &self.observed_target_root {
            validate_root(root, &format!("{path}/observedTargetRoot"))?;
        }
        if self.evidence_roots.is_empty() {
            return Err(fault(
                "malformed-provider-readback",
                &format!("{path}/evidenceRoots"),
                "evidenceRoots must not be empty",
            ));
        }
        let mut prior: Option<&str> = None;
        for (index, root) in self.evidence_roots.iter().enumerate() {
            validate_root(root, &format!("{path}/evidenceRoots/{index}"))?;
            if prior.is_some_and(|value| root.as_str() <= value) {
                return Err(fault(
                    "malformed-provider-readback",
                    &format!("{path}/evidenceRoots/{index}"),
                    "evidenceRoots must be unique and byte-sorted",
                ));
            }
            prior = Some(root);
        }
        if (self.state == "already-applied") != self.observed_target_root.is_some() {
            return Err(fault(
                "malformed-provider-readback",
                &format!("{path}/observedTargetRoot"),
                "only already-applied readback may carry an observed target root",
            ));
        }
        if self.sample_root != self.calculated_root()? {
            return Err(fault(
                "provider-readback-root-mismatch",
                &format!("{path}/sampleRoot"),
                "sampleRoot does not bind the provider-neutral readback",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReadbackCoordinates {
    pub sequence: u64,
    pub prior_entry_root: String,
    pub operation_root: String,
    pub attempt_root: String,
    pub observed_at: String,
}

impl ProviderReadbackCoordinates {
    fn validate(&self) -> ContractResult<()> {
        if self.sequence > MAX_SAFE_INTEGER as u64 {
            return Err(fault(
                "malformed-provider-readback",
                "$/coordinates/sequence",
                "readback sequence must be a canonical safe integer",
            ));
        }
        validate_root(&self.prior_entry_root, "$/coordinates/priorEntryRoot")?;
        validate_root(&self.operation_root, "$/coordinates/operationRoot")?;
        validate_root(&self.attempt_root, "$/coordinates/attemptRoot")?;
        validate_clock(&self.observed_at, "$/coordinates/observedAt")?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReadbackProjection {
    pub schema: String,
    pub classification: String,
    pub readback_roots: Vec<String>,
    pub observation: ProviderOperationEntry,
    pub projection_root: String,
}

pub fn fold_provider_readback_samples(
    samples: &[ProviderReadbackSample],
    coordinates: &ProviderReadbackCoordinates,
) -> ContractResult<ProviderReadbackProjection> {
    coordinates.validate()?;
    if samples.is_empty() {
        return Err(fault(
            "malformed-provider-readback",
            "$/samples",
            "at least one rooted provider readback sample is required",
        ));
    }
    let mut unique = BTreeMap::new();
    for (index, sample) in samples.iter().enumerate() {
        sample.validate(&format!("$/samples/{index}"))?;
        if sample.operation_root != coordinates.operation_root
            || sample.attempt_root != coordinates.attempt_root
        {
            return Err(fault(
                "provider-readback-coordinate-mismatch",
                &format!("$/samples/{index}"),
                "provider readback sample does not bind the journal coordinates",
            ));
        }
        unique.insert(sample.sample_root.clone(), sample);
    }
    let states = unique
        .values()
        .map(|sample| sample.state.as_str())
        .collect::<BTreeSet<_>>();
    if states.contains("already-applied") && states.len() != 1 {
        return Err(fault(
            "conflicting-provider-readback",
            "$/samples",
            "successful and unresolved readbacks cannot describe one attempt",
        ));
    }
    let targets = unique
        .values()
        .filter_map(|sample| sample.observed_target_root.as_deref())
        .collect::<BTreeSet<_>>();
    if targets.len() > 1 {
        return Err(fault(
            "conflicting-provider-readback",
            "$/samples",
            "provider readbacks disagree about the observed target",
        ));
    }
    let classification = if states.contains("already-applied") {
        "already-applied"
    } else if states.contains("eventually-visible") {
        "eventually-visible"
    } else {
        "not-found"
    };
    let readback_roots = unique.keys().cloned().collect::<Vec<_>>();
    let mut observation = ProviderOperationEntry::Observation(ProviderOperationObservation {
        schema: PROVIDER_OPERATION_OBSERVATION_CONTRACT.to_owned(),
        sequence: coordinates.sequence,
        prior_entry_root: Some(coordinates.prior_entry_root.clone()),
        operation_root: coordinates.operation_root.clone(),
        attempt_root: coordinates.attempt_root.clone(),
        observed_at: coordinates.observed_at.clone(),
        status: if classification == "already-applied" {
            "succeeded".to_owned()
        } else {
            "unknown".to_owned()
        },
        evidence_roots: readback_roots.clone(),
        entry_root: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .to_owned(),
    });
    let entry_root = observation.calculated_root()?;
    if let ProviderOperationEntry::Observation(value) = &mut observation {
        value.entry_root = entry_root;
    }
    observation.validate()?;
    let mut projection = ProviderReadbackProjection {
        schema: PROVIDER_READBACK_FOLD_CONTRACT.to_owned(),
        classification: classification.to_owned(),
        readback_roots,
        observation,
        projection_root: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .to_owned(),
    };
    let mut value = serde_json::to_value(&projection)
        .map_err(|error| fault("canonicalization-failed", "$/projection", error.to_string()))?;
    value
        .as_object_mut()
        .expect("serialized provider readback projection is an object")
        .remove("projectionRoot");
    projection.projection_root = content_root("provider-readback-fold", &value)?;
    Ok(projection)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderReadbackFixtures {
    schema_version: u64,
    contract: String,
    context: Value,
    coordinates: ProviderReadbackCoordinates,
    journal_prefix: Vec<Value>,
    valid_cases: Vec<ProviderReadbackFixtureCase>,
    invalid_cases: Vec<ProviderReadbackFixtureCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderReadbackFixtureCase {
    id: String,
    readbacks: Value,
    neutral_samples: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReadbackValidProjection {
    id: String,
    schema: String,
    classification: String,
    readback_roots: Vec<String>,
    observation: ProviderOperationEntry,
    projection_root: String,
    journal_state_root: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderReadbackInvalidProjection {
    id: String,
    fault: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReadbackFixtureProjection {
    pub valid_cases: Vec<ProviderReadbackValidProjection>,
    pub invalid_cases: Vec<ProviderReadbackInvalidProjection>,
}

fn decode_samples(values: Vec<Value>) -> ContractResult<Vec<ProviderReadbackSample>> {
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                fault(
                    "malformed-provider-readback",
                    "$/neutralSamples",
                    format!("invalid closed provider readback sample: {error}"),
                )
            })
        })
        .collect()
}

fn decode_journal_prefix(values: Vec<Value>) -> ContractResult<Vec<ProviderOperationEntry>> {
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                fault(
                    "invalid-provider-operation-shape",
                    "$/journalPrefix",
                    format!("invalid provider operation prefix: {error}"),
                )
            })
        })
        .collect()
}

pub fn run_provider_readback_fixture(
    bytes: &[u8],
) -> ContractResult<ProviderReadbackFixtureProjection> {
    let fixtures: ProviderReadbackFixtures = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "malformed-provider-readback",
            "$",
            format!("invalid provider readback fixtures: {error}"),
        )
    })?;
    if fixtures.schema_version != 1 || fixtures.contract != PROVIDER_READBACK_FIXTURE_CONTRACT {
        return Err(fault(
            "unsupported-provider-readback-version",
            "$/schemaVersion",
            "unsupported provider readback fixture contract",
        ));
    }
    let _adapter_only_context = fixtures.context;
    let journal_prefix = decode_journal_prefix(fixtures.journal_prefix)?;
    let valid_cases = fixtures
        .valid_cases
        .into_iter()
        .map(|fixture| {
            let _adapter_only_readbacks = fixture.readbacks;
            let projection = fold_provider_readback_samples(
                &decode_samples(fixture.neutral_samples)?,
                &fixtures.coordinates,
            )?;
            let mut journal = journal_prefix.clone();
            journal.push(projection.observation.clone());
            let journal_state_root = fold_provider_operation_journal(&journal)?.root()?;
            Ok(ProviderReadbackValidProjection {
                id: fixture.id,
                schema: projection.schema,
                classification: projection.classification,
                readback_roots: projection.readback_roots,
                observation: projection.observation,
                projection_root: projection.projection_root,
                journal_state_root,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    let invalid_cases = fixtures
        .invalid_cases
        .into_iter()
        .map(|fixture| {
            let _adapter_only_readbacks = fixture.readbacks;
            let error = decode_samples(fixture.neutral_samples)
                .and_then(|samples| {
                    fold_provider_readback_samples(&samples, &fixtures.coordinates).map(|_| ())
                })
                .err()
                .ok_or_else(|| {
                    fault(
                        "malformed-provider-readback",
                        "$/invalidCases",
                        format!("fixture {} unexpectedly passed", fixture.id),
                    )
                })?;
            Ok(ProviderReadbackInvalidProjection {
                id: fixture.id,
                fault: error.code,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    Ok(ProviderReadbackFixtureProjection {
        valid_cases,
        invalid_cases,
    })
}
