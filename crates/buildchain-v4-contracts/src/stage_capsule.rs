use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ContractFault, ContractResult, ascii_token, content_root, validate_clock, validate_root,
};

pub const STAGE_CAPSULE_IDENTITY_CONTRACT: &str = "buildchain-v4-stage-capsule-identity/v1";
pub const STAGE_CAPSULE_CONTRACT: &str = "buildchain-v4-stage-capsule/v1";
pub const STAGE_CAPSULE_AVAILABILITY_CONTRACT: &str = "buildchain-v4-stage-capsule-availability/v1";
pub const STAGE_CAPSULE_REUSE_CONTRACT: &str = "buildchain-v4-stage-capsule-reuse/v1";
const STAGE_CAPSULE_FIXTURE_CONTRACT: &str = "buildchain-v4-stage-capsule-fixtures/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedRoot {
    pub name: String,
    pub root: String,
}

fn validate_named_roots(values: &[NamedRoot], path: &str) -> ContractResult<()> {
    let mut prior: Option<&str> = None;
    for (index, entry) in values.iter().enumerate() {
        if !ascii_token(&entry.name) {
            return Err(fault(
                "invalid-stage-capsule-token",
                &format!("{path}/{index}/name"),
                "named root names must be ASCII tokens",
            ));
        }
        validate_root(&entry.root, &format!("{path}/{index}/root"))?;
        if prior.is_some_and(|name| entry.name.as_str() <= name) {
            return Err(fault(
                "unordered-stage-capsule-roots",
                &format!("{path}/{index}/name"),
                "named root names must be unique and byte-sorted",
            ));
        }
        prior = Some(&entry.name);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleIdentity {
    pub schema: String,
    pub source_root: String,
    pub platform: String,
    pub platform_root: String,
    pub stage: String,
    pub toolchain_roots: Vec<NamedRoot>,
    pub runtime_root: String,
    pub policy_root: String,
    pub declared_inputs: Vec<NamedRoot>,
    pub transformation_root: String,
    pub output_manifest_root: String,
    pub qualification_root: String,
    pub observation_roots: Vec<NamedRoot>,
}

impl StageCapsuleIdentity {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_IDENTITY_CONTRACT {
            return Err(fault(
                "unsupported-stage-capsule-version",
                "$/identity/schema",
                "unsupported Stage Capsule identity schema",
            ));
        }
        for (value, path) in [
            (&self.platform, "$/identity/platform"),
            (&self.stage, "$/identity/stage"),
        ] {
            if !ascii_token(value) {
                return Err(fault(
                    "invalid-stage-capsule-token",
                    path,
                    "Stage Capsule tokens must be ASCII tokens",
                ));
            }
        }
        for (value, path) in [
            (&self.source_root, "$/identity/sourceRoot"),
            (&self.platform_root, "$/identity/platformRoot"),
            (&self.runtime_root, "$/identity/runtimeRoot"),
            (&self.policy_root, "$/identity/policyRoot"),
            (&self.transformation_root, "$/identity/transformationRoot"),
            (&self.output_manifest_root, "$/identity/outputManifestRoot"),
            (&self.qualification_root, "$/identity/qualificationRoot"),
        ] {
            validate_root(value, path)?;
        }
        validate_named_roots(&self.toolchain_roots, "$/identity/toolchainRoots")?;
        validate_named_roots(&self.declared_inputs, "$/identity/declaredInputs")?;
        validate_named_roots(&self.observation_roots, "$/identity/observationRoots")?;
        Ok(())
    }

    pub fn root(&self) -> ContractResult<String> {
        self.validate()?;
        let value = serde_json::to_value(self)
            .map_err(|error| fault("canonicalization-failed", "$/identity", error.to_string()))?;
        content_root("stage-capsule-identity", &value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPromise {
    #[serde(rename = "class")]
    pub retention_class: String,
    pub retain_until: String,
}

impl RetentionPromise {
    fn validate(&self) -> ContractResult<()> {
        if !ascii_token(&self.retention_class) {
            return Err(fault(
                "invalid-stage-capsule-token",
                "$/retentionPromise/class",
                "retention class must be an ASCII token",
            ));
        }
        validate_clock(&self.retain_until, "$/retentionPromise/retainUntil")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsule {
    pub schema: String,
    pub writer_authority: String,
    pub rust_authority: String,
    pub identity: StageCapsuleIdentity,
    pub identity_root: String,
    pub retention_promise: RetentionPromise,
    pub capsule_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageCapsulePayload<'a> {
    schema: &'a str,
    writer_authority: &'a str,
    rust_authority: &'a str,
    identity: &'a StageCapsuleIdentity,
    identity_root: &'a str,
    retention_promise: &'a RetentionPromise,
}

impl StageCapsule {
    fn payload(&self) -> StageCapsulePayload<'_> {
        StageCapsulePayload {
            schema: &self.schema,
            writer_authority: &self.writer_authority,
            rust_authority: &self.rust_authority,
            identity: &self.identity,
            identity_root: &self.identity_root,
            retention_promise: &self.retention_promise,
        }
    }

    pub fn calculated_root(&self) -> ContractResult<String> {
        self.identity.validate()?;
        self.retention_promise.validate()?;
        let value = serde_json::to_value(self.payload())
            .map_err(|error| fault("canonicalization-failed", "$/capsule", error.to_string()))?;
        content_root("stage-capsule", &value)
    }

    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_CONTRACT {
            return Err(fault(
                "unsupported-stage-capsule-version",
                "$/schema",
                "unsupported Stage Capsule schema",
            ));
        }
        if self.writer_authority != "typescript-v3" || self.rust_authority != "validation-only" {
            return Err(fault(
                "invalid-stage-capsule-authority",
                "$/writerAuthority",
                "Stage Capsule authority must remain TypeScript v3 with validation-only Rust",
            ));
        }
        let identity_root = self.identity.root()?;
        validate_root(&self.identity_root, "$/identityRoot")?;
        if self.identity_root != identity_root {
            return Err(fault(
                "stage-capsule-identity-root-mismatch",
                "$/identityRoot",
                "identityRoot does not bind the canonical Stage Capsule identity",
            ));
        }
        validate_root(&self.capsule_root, "$/capsuleRoot")?;
        if self.capsule_root != self.calculated_root()? {
            return Err(fault(
                "stage-capsule-root-mismatch",
                "$/capsuleRoot",
                "capsuleRoot does not bind the canonical Stage Capsule",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleAvailability {
    pub schema: String,
    pub capsule_root: String,
    pub observed_at: String,
    pub status: String,
    pub content_root: Option<String>,
    pub qualification_root: Option<String>,
    pub transports: Vec<NamedRoot>,
    pub fault_code: Option<String>,
}

impl StageCapsuleAvailability {
    pub fn validate(&self) -> ContractResult<()> {
        if self.schema != STAGE_CAPSULE_AVAILABILITY_CONTRACT {
            return Err(fault(
                "unsupported-stage-capsule-version",
                "$/availability/schema",
                "unsupported Stage Capsule availability schema",
            ));
        }
        validate_root(&self.capsule_root, "$/availability/capsuleRoot")?;
        validate_clock(&self.observed_at, "$/availability/observedAt")?;
        if ![
            "available",
            "missing",
            "expired",
            "corrupt",
            "root-mismatch",
        ]
        .contains(&self.status.as_str())
        {
            return Err(fault(
                "invalid-stage-capsule-availability",
                "$/availability/status",
                "unsupported Stage Capsule availability status",
            ));
        }
        if let Some(root) = &self.content_root {
            validate_root(root, "$/availability/contentRoot")?;
        }
        if let Some(root) = &self.qualification_root {
            validate_root(root, "$/availability/qualificationRoot")?;
        }
        validate_named_roots(&self.transports, "$/availability/transports")?;
        if let Some(code) = &self.fault_code
            && !ascii_token(code)
        {
            return Err(fault(
                "invalid-stage-capsule-token",
                "$/availability/faultCode",
                "availability faultCode must be an ASCII token",
            ));
        }
        if self.status == "available"
            && (self.content_root.is_none()
                || self.qualification_root.is_none()
                || self.fault_code.is_some())
        {
            return Err(fault(
                "invalid-stage-capsule-availability",
                "$/availability",
                "available content requires content and qualification roots without a fault",
            ));
        }
        if self.status != "available" && self.fault_code.is_none() {
            return Err(fault(
                "invalid-stage-capsule-availability",
                "$/availability/faultCode",
                "unavailable content requires a typed fault code",
            ));
        }
        Ok(())
    }

    pub fn root(&self) -> ContractResult<String> {
        self.validate()?;
        let value = serde_json::to_value(self).map_err(|error| {
            fault(
                "canonicalization-failed",
                "$/availability",
                error.to_string(),
            )
        })?;
        content_root("stage-capsule-availability", &value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleReuseRequest {
    pub schema: String,
    pub capsule: StageCapsule,
    pub availability: StageCapsuleAvailability,
    pub evaluated_at: String,
    pub expected_capsule_root: String,
    pub expected_output_manifest_root: String,
    pub expected_qualification_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleReuseDecision {
    pub schema: String,
    pub eligible: bool,
    pub capsule_root: String,
    pub availability_root: String,
    pub reason: String,
}

pub fn evaluate_stage_capsule_reuse(
    request: &StageCapsuleReuseRequest,
) -> ContractResult<StageCapsuleReuseDecision> {
    if request.schema != STAGE_CAPSULE_REUSE_CONTRACT {
        return Err(fault(
            "unsupported-stage-capsule-version",
            "$/schema",
            "unsupported Stage Capsule reuse schema",
        ));
    }
    request.capsule.validate()?;
    request.availability.validate()?;
    validate_clock(&request.evaluated_at, "$/evaluatedAt")?;
    for (value, path) in [
        (&request.expected_capsule_root, "$/expectedCapsuleRoot"),
        (
            &request.expected_output_manifest_root,
            "$/expectedOutputManifestRoot",
        ),
        (
            &request.expected_qualification_root,
            "$/expectedQualificationRoot",
        ),
    ] {
        validate_root(value, path)?;
    }
    let availability_root = request.availability.root()?;
    let decision = |eligible: bool, reason: &str| StageCapsuleReuseDecision {
        schema: STAGE_CAPSULE_REUSE_CONTRACT.to_owned(),
        eligible,
        capsule_root: request.capsule.capsule_root.clone(),
        availability_root: availability_root.clone(),
        reason: reason.to_owned(),
    };
    if request.expected_capsule_root != request.capsule.capsule_root
        || request.availability.capsule_root != request.capsule.capsule_root
    {
        return Ok(decision(false, "root-mismatch"));
    }
    if request.availability.status != "available" {
        return Ok(decision(false, &request.availability.status));
    }
    if request.evaluated_at > request.capsule.retention_promise.retain_until {
        return Ok(decision(false, "expired"));
    }
    if request.expected_output_manifest_root != request.capsule.identity.output_manifest_root
        || request.availability.content_root.as_ref()
            != Some(&request.capsule.identity.output_manifest_root)
        || request.expected_qualification_root != request.capsule.identity.qualification_root
        || request.availability.qualification_root.as_ref()
            != Some(&request.capsule.identity.qualification_root)
    {
        return Ok(decision(false, "root-mismatch"));
    }
    Ok(decision(true, "eligible"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageCapsuleFixtures {
    schema_version: u64,
    contract: String,
    valid_cases: Vec<ValidFixture>,
    invalid_cases: Vec<InvalidFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidFixture {
    id: String,
    capsule: StageCapsule,
    availability: StageCapsuleAvailability,
    reuse: ValidReuseFixture,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidReuseFixture {
    evaluated_at: String,
    expected_capsule_root: String,
    expected_output_manifest_root: String,
    expected_qualification_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvalidFixture {
    id: String,
    kind: String,
    value: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidFixtureProjection {
    id: String,
    identity_root: String,
    capsule_root: String,
    availability_root: String,
    reuse: StageCapsuleReuseDecision,
}

#[derive(Debug, Serialize)]
pub struct InvalidFixtureProjection {
    id: String,
    fault: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleFixtureProjection {
    pub valid_cases: Vec<ValidFixtureProjection>,
    pub invalid_cases: Vec<InvalidFixtureProjection>,
}

fn decode_fault<T>(value: Value) -> Result<T, Box<ContractFault>>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|error| {
        fault(
            "invalid-stage-capsule-shape",
            "$",
            format!("invalid closed Stage Capsule shape: {error}"),
        )
    })
}

pub fn run_stage_capsule_fixture(bytes: &[u8]) -> ContractResult<StageCapsuleFixtureProjection> {
    let fixtures: StageCapsuleFixtures = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "invalid-stage-capsule-fixture",
            "$",
            format!("invalid Stage Capsule fixtures: {error}"),
        )
    })?;
    if fixtures.schema_version != 1 || fixtures.contract != STAGE_CAPSULE_FIXTURE_CONTRACT {
        return Err(fault(
            "unsupported-stage-capsule-version",
            "$/schemaVersion",
            "unsupported Stage Capsule fixture contract",
        ));
    }
    let valid_cases = fixtures
        .valid_cases
        .into_iter()
        .map(|fixture| {
            fixture.capsule.validate()?;
            fixture.availability.validate()?;
            let request = StageCapsuleReuseRequest {
                schema: STAGE_CAPSULE_REUSE_CONTRACT.to_owned(),
                capsule: fixture.capsule.clone(),
                availability: fixture.availability.clone(),
                evaluated_at: fixture.reuse.evaluated_at,
                expected_capsule_root: fixture.reuse.expected_capsule_root,
                expected_output_manifest_root: fixture.reuse.expected_output_manifest_root,
                expected_qualification_root: fixture.reuse.expected_qualification_root,
            };
            let reuse = evaluate_stage_capsule_reuse(&request)?;
            Ok(ValidFixtureProjection {
                id: fixture.id,
                identity_root: fixture.capsule.identity.root()?,
                capsule_root: fixture.capsule.calculated_root()?,
                availability_root: fixture.availability.root()?,
                reuse,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    let invalid_cases = fixtures
        .invalid_cases
        .into_iter()
        .map(|fixture| {
            let error = match fixture.kind.as_str() {
                "identity" => decode_fault::<StageCapsuleIdentity>(fixture.value)
                    .and_then(|value| value.validate()),
                "capsule" => {
                    decode_fault::<StageCapsule>(fixture.value).and_then(|value| value.validate())
                }
                "availability" => decode_fault::<StageCapsuleAvailability>(fixture.value)
                    .and_then(|value| value.validate()),
                "reuse" => decode_fault::<StageCapsuleReuseRequest>(fixture.value)
                    .and_then(|value| evaluate_stage_capsule_reuse(&value).map(|_| ())),
                _ => Err(fault(
                    "invalid-stage-capsule-fixture",
                    "$/invalidCases/kind",
                    "unsupported invalid fixture kind",
                )),
            }
            .err()
            .ok_or_else(|| {
                fault(
                    "invalid-stage-capsule-fixture",
                    "$/invalidCases",
                    format!("fixture {} unexpectedly passed", fixture.id),
                )
            })?;
            Ok(InvalidFixtureProjection {
                id: fixture.id,
                fault: error.code,
            })
        })
        .collect::<ContractResult<Vec<_>>>()?;
    Ok(StageCapsuleFixtureProjection {
        valid_cases,
        invalid_cases,
    })
}
