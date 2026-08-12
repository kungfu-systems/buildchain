use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{ContractFault, ContractResult, content_root, validate_root};

pub const ADOPTER_DELIVERY_PARITY_INPUT_CONTRACT: &str =
    "kungfu-buildchain-v4-adopter-delivery-parity-input";
pub const ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT: &str =
    "buildchain-v4-adopter-delivery-parity-projection/v1";

const REQUEST_CONTRACT: &str = "kungfu-buildchain-adopter-delivery-request";
const RESULT_CONTRACT: &str = "kungfu-buildchain-adopter-delivery-result";
const DRIVER_INTERFACE: &str = "kungfu-buildchain-adopter-protocol-driver/v1";
const PROFILE_INTERFACE: &str = "kungfu-buildchain-adopter-artifact-profile/v1";
const KFD_PACKAGE: &str = "@kungfu-tech/kfd@1.0.0-alpha.62";
const V3_COMMIT: &str = "c3f58d76391c1c6ceddfc900a68e91c7ab82a575";
const VECTOR_SUITE_ROOT: &str =
    "sha256:cf329805d928a9883cbafbdfdf21ef66c6a0889ed8dfe14356b4e0d25d6738f9";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryParitySource {
    pub v3_commit: String,
    pub vector_suite_root: String,
    pub kfd_package: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdopterDeliveryReference {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryArtifact {
    pub kind: String,
    pub coordinate: String,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryProject {
    pub instance_id: String,
    pub adopter_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryRequest {
    pub schema_version: u8,
    pub contract: String,
    pub protocol: AdopterDeliveryReference,
    pub artifact_profile: AdopterDeliveryReference,
    pub project: AdopterDeliveryProject,
    pub artifact: AdopterDeliveryArtifact,
    pub declaration: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdopterDeliveryIssue {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryExecution {
    pub state: String,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryDriver {
    pub interface: String,
    pub id: String,
    pub version: String,
    pub execution: Option<AdopterDeliveryExecution>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryArtifactProfile {
    pub interface: String,
    pub id: String,
    pub version: String,
    pub kinds: Vec<String>,
    pub execution: Option<AdopterDeliveryExecution>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdopterDeliveryParityInput {
    pub schema_version: u8,
    pub contract: String,
    pub vector_id: String,
    pub source_authority: AdopterDeliveryParitySource,
    pub request: AdopterDeliveryRequest,
    pub driver: Option<AdopterDeliveryDriver>,
    pub artifact_profile: Option<AdopterDeliveryArtifactProfile>,
    pub expected_result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileResult {
    valid: bool,
    issues: Vec<AdopterDeliveryIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverResult {
    valid: bool,
    report: Value,
    report_root: String,
    issues: Vec<AdopterDeliveryIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolResult {
    id: String,
    version: String,
    loaded: bool,
    report_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProfileResult {
    id: String,
    version: String,
    loaded: bool,
    valid: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateResultBody {
    schema_version: u8,
    contract: String,
    status: String,
    qualifying: bool,
    self_certified: bool,
    project: AdopterDeliveryProject,
    artifact: AdopterDeliveryArtifact,
    protocol: ProtocolResult,
    artifact_profile: ArtifactProfileResult,
    semantic_report: Option<Value>,
    non_claims: Vec<String>,
    issues: Vec<AdopterDeliveryIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateResult {
    #[serde(flatten)]
    body: GateResultBody,
    gate_root: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdopterDeliveryParityProjection {
    pub schema: String,
    pub effect_mode: String,
    pub vector_id: String,
    pub source_authority: AdopterDeliveryParitySource,
    pub result: Value,
    pub projection_root: String,
}

fn issue(code: &str, path: &str, message: &str) -> AdopterDeliveryIssue {
    AdopterDeliveryIssue {
        code: code.to_owned(),
        path: path.to_owned(),
        message: message.to_owned(),
    }
}

fn exact_reference(reference: &AdopterDeliveryReference, path: &str) -> ContractResult<()> {
    let valid_id = !reference.id.is_empty()
        && reference.id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'/')
        });
    let version_parts = reference.version.split('.').collect::<Vec<_>>();
    let valid_version = version_parts.len() == 3
        && version_parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    if !valid_id || !valid_version {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-reference",
            path,
            "adopter delivery references must use exact lowercase ids and semantic versions",
        )));
    }
    Ok(())
}

fn validate_issue(value: &AdopterDeliveryIssue, path: &str) -> ContractResult<()> {
    if value.code.is_empty() || value.message.is_empty() || !value.path.starts_with('/') {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-issue",
            path,
            "adopter delivery issues require stable code, path, and message fields",
        )));
    }
    Ok(())
}

fn validate_input(input: &AdopterDeliveryParityInput) -> ContractResult<()> {
    if input.schema_version != 1
        || input.contract != ADOPTER_DELIVERY_PARITY_INPUT_CONTRACT
        || input.vector_id.is_empty()
        || input.request.schema_version != 1
        || input.request.contract != REQUEST_CONTRACT
        || input.source_authority.kfd_package != KFD_PACKAGE
        || input.source_authority.v3_commit != V3_COMMIT
        || input.source_authority.vector_suite_root != VECTOR_SUITE_ROOT
    {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-parity-input",
            "$",
            "the parity input is not bound to the exact v3 and published KFD authority",
        )));
    }
    validate_root(
        &input.source_authority.vector_suite_root,
        "$.sourceAuthority.vectorSuiteRoot",
    )?;
    validate_root(&input.request.artifact.root, "$.request.artifact.root")?;
    exact_reference(&input.request.protocol, "$.request.protocol")?;
    exact_reference(&input.request.artifact_profile, "$.request.artifactProfile")?;
    if !input.request.declaration.is_object()
        || input.request.project.instance_id.is_empty()
        || input.request.project.adopter_id.is_empty()
        || input.request.artifact.kind.is_empty()
        || input.request.artifact.coordinate.is_empty()
    {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-request",
            "$.request",
            "the parity request must retain the exact finite project, artifact, and declaration",
        )));
    }
    Ok(())
}

fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(stable_value).collect()),
        Value::Object(object) => {
            let sorted = object
                .iter()
                .map(|(key, value)| (key.clone(), stable_value(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn gate_digest(value: &Value) -> ContractResult<String> {
    let bytes = serde_json::to_vec(&stable_value(value)).map_err(|error| {
        Box::new(ContractFault::validation(
            "adopter-delivery-digest-failed",
            "$",
            format!("cannot serialize adopter delivery result: {error}"),
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn matching_driver(
    input: &AdopterDeliveryParityInput,
) -> ContractResult<Option<&AdopterDeliveryDriver>> {
    let Some(driver) = input.driver.as_ref() else {
        return Ok(None);
    };
    if driver.interface != DRIVER_INTERFACE {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-driver",
            "$.driver.interface",
            "the parity driver must use the protocol driver interface",
        )));
    }
    Ok(
        (driver.id == input.request.protocol.id
            && driver.version == input.request.protocol.version)
            .then_some(driver),
    )
}

fn matching_profile(
    input: &AdopterDeliveryParityInput,
) -> ContractResult<Option<&AdopterDeliveryArtifactProfile>> {
    let Some(profile) = input.artifact_profile.as_ref() else {
        return Ok(None);
    };
    if profile.interface != PROFILE_INTERFACE || profile.kinds.is_empty() {
        return Err(Box::new(ContractFault::validation(
            "invalid-adopter-delivery-profile",
            "$.artifactProfile",
            "the parity artifact profile must use the exact non-empty profile interface",
        )));
    }
    Ok((profile.id == input.request.artifact_profile.id
        && profile.version == input.request.artifact_profile.version)
        .then_some(profile))
}

fn returned_profile(execution: &AdopterDeliveryExecution) -> Option<ProfileResult> {
    (execution.state == "returned")
        .then(|| execution.result.clone())
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn returned_driver(execution: &AdopterDeliveryExecution) -> Option<DriverResult> {
    let result = (execution.state == "returned")
        .then(|| execution.result.clone())
        .flatten()
        .and_then(|value| serde_json::from_value::<DriverResult>(value).ok())?;
    validate_root(&result.report_root, "$.driver.execution.result.reportRoot").ok()?;
    result
        .issues
        .iter()
        .enumerate()
        .try_for_each(|(index, issue)| validate_issue(issue, &format!("$.driver.issues/{index}")))
        .ok()?;
    Some(result)
}

fn evaluate(input: &AdopterDeliveryParityInput) -> ContractResult<GateResult> {
    let driver = matching_driver(input)?;
    let profile = matching_profile(input)?;
    let mut issues = Vec::new();
    if driver.is_none() {
        issues.push(issue(
            "delivery-driver-unknown",
            "/protocol",
            "No exact protocol driver is registered.",
        ));
    }
    if profile.is_none() {
        issues.push(issue(
            "delivery-artifact-profile-unknown",
            "/artifactProfile",
            "No exact artifact profile is registered.",
        ));
    }

    let mut profile_valid = false;
    if let Some(profile) = profile {
        if !profile.kinds.contains(&input.request.artifact.kind) {
            issues.push(issue(
                "delivery-artifact-kind-mismatch",
                "/artifact/kind",
                "Artifact kind is not admitted by the selected profile.",
            ));
        } else if let Some(execution) = profile.execution.as_ref() {
            if execution.state == "threw" {
                issues.push(issue(
                    "delivery-artifact-profile-error",
                    "/artifactProfile",
                    "Artifact profile execution failed closed.",
                ));
            } else if let Some(result) = returned_profile(execution) {
                result
                    .issues
                    .iter()
                    .enumerate()
                    .try_for_each(|(index, issue)| {
                        validate_issue(issue, &format!("$.artifactProfile.issues/{index}"))
                    })?;
                profile_valid = result.valid;
                let result_issue_count = result.issues.len();
                issues.extend(result.issues);
                if !profile_valid && result_issue_count == 0 {
                    issues.push(issue(
                        "delivery-artifact-rejected",
                        "/artifact",
                        "Artifact profile rejected the artifact.",
                    ));
                }
            } else {
                issues.push(issue(
                    "delivery-artifact-profile-result-invalid",
                    "/artifactProfile",
                    "Artifact profile returned an invalid result.",
                ));
            }
        }
    }

    let mut semantic_report = None;
    let mut report_root = None;
    if let Some(driver) = driver.filter(|_| profile_valid)
        && let Some(execution) = driver.execution.as_ref()
    {
        if execution.state == "threw" {
            issues.push(issue(
                "delivery-driver-error",
                "/protocol",
                "Protocol driver execution failed closed.",
            ));
        } else if let Some(result) = returned_driver(execution) {
            semantic_report = Some(result.report);
            report_root = Some(result.report_root);
            let valid = result.valid;
            let result_issue_count = result.issues.len();
            issues.extend(result.issues);
            if !valid && result_issue_count == 0 {
                issues.push(issue(
                    "delivery-semantic-rejected",
                    "/declaration",
                    "Protocol driver rejected the declaration.",
                ));
            }
        } else {
            issues.push(issue(
                "delivery-driver-result-invalid",
                "/protocol",
                "Protocol driver returned an invalid result.",
            ));
        }
    }
    issues.sort_by(|left, right| {
        (&left.code, &left.path, &left.message).cmp(&(&right.code, &right.path, &right.message))
    });

    let body = GateResultBody {
        schema_version: 1,
        contract: RESULT_CONTRACT.to_owned(),
        status: if issues.is_empty() { "passed" } else { "failed" }.to_owned(),
        qualifying: false,
        self_certified: false,
        project: input.request.project.clone(),
        artifact: input.request.artifact.clone(),
        protocol: ProtocolResult {
            id: input.request.protocol.id.clone(),
            version: input.request.protocol.version.clone(),
            loaded: driver.is_some(),
            report_root,
        },
        artifact_profile: ArtifactProfileResult {
            id: input.request.artifact_profile.id.clone(),
            version: input.request.artifact_profile.version.clone(),
            loaded: profile.is_some(),
            valid: profile_valid,
        },
        semantic_report,
        non_claims: vec![
            "A passing delivery gate does not grant runtime permission, release authorization, or independent certification.".to_owned(),
            "Protocol semantics remain owned by the selected protocol driver and its published authority.".to_owned(),
        ],
        issues,
    };
    let body_value = serde_json::to_value(&body).map_err(|error| {
        Box::new(ContractFault::validation(
            "adopter-delivery-result-serialization-failed",
            "$",
            error.to_string(),
        ))
    })?;
    Ok(GateResult {
        gate_root: gate_digest(&body_value)?,
        body,
    })
}

pub fn project_adopter_delivery_parity(
    input: &AdopterDeliveryParityInput,
) -> ContractResult<AdopterDeliveryParityProjection> {
    validate_input(input)?;
    let result = serde_json::to_value(evaluate(input)?).map_err(|error| {
        Box::new(ContractFault::validation(
            "adopter-delivery-result-serialization-failed",
            "$",
            error.to_string(),
        ))
    })?;
    if result != input.expected_result {
        return Err(Box::new(ContractFault::validation(
            "adopter-delivery-parity-mismatch",
            "$.expectedResult",
            "the effect-disabled v4 projection differs from the exact v3 decision",
        )));
    }
    let body = serde_json::json!({
        "schema": ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT,
        "effectMode": "disabled",
        "vectorId": input.vector_id,
        "sourceAuthority": input.source_authority,
        "result": result,
    });
    Ok(AdopterDeliveryParityProjection {
        schema: ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT.to_owned(),
        effect_mode: "disabled".to_owned(),
        vector_id: input.vector_id.clone(),
        source_authority: input.source_authority.clone(),
        result,
        projection_root: content_root("adopter-delivery-parity", &body)?,
    })
}

pub fn project_adopter_delivery_parity_bytes(
    bytes: &[u8],
) -> ContractResult<AdopterDeliveryParityProjection> {
    let input = serde_json::from_slice::<AdopterDeliveryParityInput>(bytes).map_err(|error| {
        Box::new(ContractFault::validation(
            "invalid-adopter-delivery-parity-json",
            "$",
            format!("cannot parse adopter delivery parity input: {error}"),
        ))
    })?;
    project_adopter_delivery_parity(&input)
}
