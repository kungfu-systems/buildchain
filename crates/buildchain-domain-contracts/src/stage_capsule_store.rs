use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::stage_capsule::{StageCapsule, StageCapsuleAvailability};
use crate::{
    ContractFault, ContractResult, ascii_token, content_root, validate_clock, validate_root,
};

pub const STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT: &str =
    "buildchain-v4-stage-capsule-output-manifest/v1";
pub const STAGE_CAPSULE_RETENTION_STATE_CONTRACT: &str =
    "buildchain-v4-stage-capsule-retention-state/v1";
pub const STAGE_CAPSULE_TRANSPORT_CONTRACT: &str = "buildchain-v4-stage-capsule-transport/v1";
pub const STAGE_CAPSULE_STORE_RECEIPT_CONTRACT: &str =
    "buildchain-v4-stage-capsule-store-receipt/v1";
const STAGE_CAPSULE_STORE_FIXTURE_CONTRACT: &str = "buildchain-v4-stage-capsule-store-fixtures/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

pub fn stage_capsule_blob_root(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleContentEntry {
    pub name: String,
    pub root: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleOutputManifest {
    pub schema: String,
    pub entries: Vec<StageCapsuleContentEntry>,
    pub manifest_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPayload<'a> {
    schema: &'a str,
    entries: &'a [StageCapsuleContentEntry],
}

impl StageCapsuleOutputManifest {
    fn payload(&self) -> ManifestPayload<'_> {
        ManifestPayload {
            schema: &self.schema,
            entries: &self.entries,
        }
    }

    pub fn calculated_root(&self) -> ContractResult<String> {
        let value = serde_json::to_value(self.payload())
            .map_err(|error| fault("canonicalization-failed", "$/manifest", error.to_string()))?;
        content_root("stage-capsule-output-manifest", &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT || self.entries.is_empty() {
            return Err(fault(
                "unsupported-stage-capsule-store-version",
                "$/manifest",
                "unsupported or empty Stage Capsule output manifest",
            ));
        }
        let mut prior: Option<&str> = None;
        for (index, entry) in self.entries.iter().enumerate() {
            if !ascii_token(&entry.name) {
                return Err(fault(
                    "invalid-stage-capsule-store-token",
                    &format!("$/manifest/entries/{index}/name"),
                    "content name must be an ASCII token",
                ));
            }
            validate_root(&entry.root, &format!("$/manifest/entries/{index}/root"))?;
            if prior.is_some_and(|name| entry.name.as_str() <= name) {
                return Err(fault(
                    "unordered-stage-capsule-content",
                    &format!("$/manifest/entries/{index}/name"),
                    "content names must be unique and byte-sorted",
                ));
            }
            prior = Some(&entry.name);
        }
        validate_root(&self.manifest_root, "$/manifest/manifestRoot")?;
        if self.manifest_root != self.calculated_root()? {
            return Err(fault(
                "stage-capsule-manifest-root-mismatch",
                "$/manifest/manifestRoot",
                "manifestRoot does not bind the canonical output manifest",
            ));
        }
        Ok(())
    }
}

fn retention_promise_root(capsule: &StageCapsule) -> ContractResult<String> {
    let value = serde_json::to_value(&capsule.retention_promise).map_err(|error| {
        fault(
            "canonicalization-failed",
            "$/retentionPromise",
            error.to_string(),
        )
    })?;
    content_root("stage-capsule-retention-promise", &value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleRetentionState {
    pub schema: String,
    pub capsule_root: String,
    pub promise_root: String,
    pub evaluated_at: String,
    pub status: String,
    pub state_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetentionStatePayload<'a> {
    schema: &'a str,
    capsule_root: &'a str,
    promise_root: &'a str,
    evaluated_at: &'a str,
    status: &'a str,
}

impl StageCapsuleRetentionState {
    pub fn from_capsule(capsule: &StageCapsule, evaluated_at: &str) -> ContractResult<Self> {
        capsule.validate()?;
        validate_clock(evaluated_at, "$/retentionState/evaluatedAt")?;
        let mut state = Self {
            schema: STAGE_CAPSULE_RETENTION_STATE_CONTRACT.to_owned(),
            capsule_root: capsule.capsule_root.clone(),
            promise_root: retention_promise_root(capsule)?,
            evaluated_at: evaluated_at.to_owned(),
            status: if evaluated_at <= capsule.retention_promise.retain_until.as_str() {
                "retained".to_owned()
            } else {
                "expired".to_owned()
            },
            state_root: String::new(),
        };
        state.state_root = state.calculated_root()?;
        Ok(state)
    }

    fn payload(&self) -> RetentionStatePayload<'_> {
        RetentionStatePayload {
            schema: &self.schema,
            capsule_root: &self.capsule_root,
            promise_root: &self.promise_root,
            evaluated_at: &self.evaluated_at,
            status: &self.status,
        }
    }

    pub fn calculated_root(&self) -> ContractResult<String> {
        let value = serde_json::to_value(self.payload()).map_err(|error| {
            fault(
                "canonicalization-failed",
                "$/retentionState",
                error.to_string(),
            )
        })?;
        content_root("stage-capsule-retention-state", &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_RETENTION_STATE_CONTRACT
            || !["retained", "expired"].contains(&self.status.as_str())
        {
            return Err(fault(
                "invalid-stage-capsule-retention-state",
                "$/retentionState",
                "unsupported Stage Capsule retention state",
            ));
        }
        validate_root(&self.capsule_root, "$/retentionState/capsuleRoot")?;
        validate_root(&self.promise_root, "$/retentionState/promiseRoot")?;
        validate_clock(&self.evaluated_at, "$/retentionState/evaluatedAt")?;
        validate_root(&self.state_root, "$/retentionState/stateRoot")?;
        if self.state_root != self.calculated_root()? {
            return Err(fault(
                "stage-capsule-retention-root-mismatch",
                "$/retentionState/stateRoot",
                "stateRoot does not bind the retention observation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleTransport {
    pub schema: String,
    pub provider: String,
    pub mode: String,
    pub locator_root: String,
    pub observed_at: String,
    pub transport_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportPayload<'a> {
    schema: &'a str,
    provider: &'a str,
    mode: &'a str,
    locator_root: &'a str,
    observed_at: &'a str,
}

impl StageCapsuleTransport {
    fn payload(&self) -> TransportPayload<'_> {
        TransportPayload {
            schema: &self.schema,
            provider: &self.provider,
            mode: &self.mode,
            locator_root: &self.locator_root,
            observed_at: &self.observed_at,
        }
    }

    pub fn calculated_root(&self) -> ContractResult<String> {
        let value = serde_json::to_value(self.payload())
            .map_err(|error| fault("canonicalization-failed", "$/transport", error.to_string()))?;
        content_root("stage-capsule-transport", &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_TRANSPORT_CONTRACT
            || !["local-filesystem", "github-artifacts", "s3-compatible"]
                .contains(&self.provider.as_str())
            || !["local-reference", "effect-disabled", "fixture-backed"]
                .contains(&self.mode.as_str())
        {
            return Err(fault(
                "unsupported-stage-capsule-transport",
                "$/transport",
                "unsupported transport provider or mode",
            ));
        }
        validate_root(&self.locator_root, "$/transport/locatorRoot")?;
        validate_clock(&self.observed_at, "$/transport/observedAt")?;
        validate_root(&self.transport_root, "$/transport/transportRoot")?;
        if self.transport_root != self.calculated_root()? {
            return Err(fault(
                "stage-capsule-transport-root-mismatch",
                "$/transport/transportRoot",
                "transportRoot does not bind the transport observation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleStoreReceipt {
    pub schema: String,
    pub operation: String,
    pub recorded_at: String,
    pub capsule_root: String,
    pub manifest_root: String,
    pub retention_state_root: String,
    pub availability_root: String,
    pub transport_root: String,
    pub qualification_root: String,
    pub outcome: String,
    pub fault_code: Option<String>,
    pub receipt_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreReceiptPayload<'a> {
    schema: &'a str,
    operation: &'a str,
    recorded_at: &'a str,
    capsule_root: &'a str,
    manifest_root: &'a str,
    retention_state_root: &'a str,
    availability_root: &'a str,
    transport_root: &'a str,
    qualification_root: &'a str,
    outcome: &'a str,
    fault_code: &'a Option<String>,
}

impl StageCapsuleStoreReceipt {
    fn payload(&self) -> StoreReceiptPayload<'_> {
        StoreReceiptPayload {
            schema: &self.schema,
            operation: &self.operation,
            recorded_at: &self.recorded_at,
            capsule_root: &self.capsule_root,
            manifest_root: &self.manifest_root,
            retention_state_root: &self.retention_state_root,
            availability_root: &self.availability_root,
            transport_root: &self.transport_root,
            qualification_root: &self.qualification_root,
            outcome: &self.outcome,
            fault_code: &self.fault_code,
        }
    }

    pub fn calculated_root(&self) -> ContractResult<String> {
        let value = serde_json::to_value(self.payload())
            .map_err(|error| fault("canonicalization-failed", "$/receipt", error.to_string()))?;
        content_root("stage-capsule-store-receipt", &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_STORE_RECEIPT_CONTRACT
            || !["put", "locate", "restore", "quarantine"].contains(&self.operation.as_str())
            || ![
                "stored",
                "already-stored",
                "located",
                "restored",
                "quarantined",
            ]
            .contains(&self.outcome.as_str())
            || self.fault_code.is_some()
        {
            return Err(fault(
                "invalid-stage-capsule-store-receipt",
                "$/receipt",
                "unsupported successful store receipt",
            ));
        }
        validate_clock(&self.recorded_at, "$/receipt/recordedAt")?;
        for (root, path) in [
            (&self.capsule_root, "$/receipt/capsuleRoot"),
            (&self.manifest_root, "$/receipt/manifestRoot"),
            (&self.retention_state_root, "$/receipt/retentionStateRoot"),
            (&self.availability_root, "$/receipt/availabilityRoot"),
            (&self.transport_root, "$/receipt/transportRoot"),
            (&self.qualification_root, "$/receipt/qualificationRoot"),
            (&self.receipt_root, "$/receipt/receiptRoot"),
        ] {
            validate_root(root, path)?;
        }
        if self.receipt_root != self.calculated_root()? {
            return Err(fault(
                "stage-capsule-store-receipt-root-mismatch",
                "$/receipt/receiptRoot",
                "receiptRoot does not bind the store receipt",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreFixtures {
    schema_version: u64,
    contract: String,
    valid_cases: Vec<StoreFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreFixture {
    id: String,
    capsule: StageCapsule,
    manifest: StageCapsuleOutputManifest,
    blobs: Vec<StoreFixtureBlob>,
    evaluated_at: String,
    retention_state: StageCapsuleRetentionState,
    transport: StageCapsuleTransport,
    availability: StageCapsuleAvailability,
    receipt: StageCapsuleStoreReceipt,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreFixtureBlob {
    name: String,
    root: String,
    bytes_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreFixtureProjection {
    id: String,
    manifest_root: String,
    retention_state_root: String,
    transport_root: String,
    availability_root: String,
    receipt_root: String,
    blob_roots: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleStoreFixtureProjection {
    pub valid_cases: Vec<StoreFixtureProjection>,
}

pub fn run_stage_capsule_store_fixture(
    bytes: &[u8],
) -> ContractResult<StageCapsuleStoreFixtureProjection> {
    let fixtures: StoreFixtures = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "invalid-stage-capsule-store-fixture",
            "$",
            error.to_string(),
        )
    })?;
    if fixtures.schema_version != 1 || fixtures.contract != STAGE_CAPSULE_STORE_FIXTURE_CONTRACT {
        return Err(fault(
            "unsupported-stage-capsule-store-version",
            "$/schemaVersion",
            "unsupported Stage Capsule store fixture contract",
        ));
    }
    let valid_cases = fixtures
        .valid_cases
        .into_iter()
        .map(|fixture| {
            fixture.capsule.validate()?;
            fixture.manifest.validate()?;
            if fixture.capsule.identity.output_manifest_root != fixture.manifest.manifest_root {
                return Err(fault(
                    "stage-capsule-root-mismatch",
                    "$/manifest/manifestRoot",
                    "capsule does not bind the fixture manifest",
                ));
            }
            if fixture.blobs.len() != fixture.manifest.entries.len() {
                return Err(fault(
                    "stage-capsule-partial",
                    "$/blobs",
                    "fixture blobs do not close the manifest",
                ));
            }
            let mut blob_roots = Vec::new();
            for (blob, entry) in fixture.blobs.iter().zip(&fixture.manifest.entries) {
                let decoded = BASE64.decode(&blob.bytes_base64).map_err(|_| {
                    fault(
                        "invalid-stage-capsule-store-fixture",
                        "$/blobs/bytesBase64",
                        "fixture blob is not canonical base64",
                    )
                })?;
                let root = stage_capsule_blob_root(&decoded);
                if blob.name != entry.name
                    || blob.root != entry.root
                    || root != entry.root
                    || decoded.len() as u64 != entry.size
                {
                    return Err(fault(
                        "stage-capsule-root-mismatch",
                        "$/blobs",
                        "fixture blob does not match the manifest",
                    ));
                }
                blob_roots.push(root);
            }
            let retention =
                StageCapsuleRetentionState::from_capsule(&fixture.capsule, &fixture.evaluated_at)?;
            retention.validate()?;
            fixture.retention_state.validate()?;
            if fixture.retention_state != retention {
                return Err(fault(
                    "stage-capsule-retention-root-mismatch",
                    "$/retentionState",
                    "fixture retention state is not the exact derived observation",
                ));
            }
            fixture.transport.validate()?;
            fixture.availability.validate()?;
            fixture.receipt.validate()?;
            let availability_root = fixture.availability.root()?;
            if fixture.receipt.capsule_root != fixture.capsule.capsule_root
                || fixture.receipt.manifest_root != fixture.manifest.manifest_root
                || fixture.receipt.retention_state_root != retention.state_root
                || fixture.receipt.transport_root != fixture.transport.transport_root
                || fixture.receipt.availability_root != availability_root
                || fixture.receipt.qualification_root != fixture.capsule.identity.qualification_root
            {
                return Err(fault(
                    "stage-capsule-root-mismatch",
                    "$/receipt",
                    "store receipt does not bind the fixture roots",
                ));
            }
            Ok(StoreFixtureProjection {
                id: fixture.id,
                manifest_root: fixture.manifest.manifest_root,
                retention_state_root: retention.state_root,
                transport_root: fixture.transport.transport_root,
                availability_root,
                receipt_root: fixture.receipt.receipt_root,
                blob_roots,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    Ok(StageCapsuleStoreFixtureProjection { valid_cases })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_blob_roots_are_byte_sensitive() {
        assert_ne!(
            stage_capsule_blob_root(b"a"),
            stage_capsule_blob_root(b"a\n")
        );
    }
}
