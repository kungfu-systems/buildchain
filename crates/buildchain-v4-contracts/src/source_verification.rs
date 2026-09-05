use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{ContractFault, ContractResult, content_root, validate_root};

const SCHEMA: &str = "buildchain-v4-source-verification-evidence/v1";
const MAX_AGE_MS: u64 = 6 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    repository: String,
    source_sha: String,
    source_tree: String,
    workflow_root: String,
    check_definition_root: String,
    runtime_root: String,
    toolchain_root: String,
    dependency_root: String,
    environment_root: String,
    platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    schema: String,
    identity: Identity,
    run_id: String,
    run_attempt: u64,
    event: String,
    validation_kind: String,
    started_at_ms: u64,
    completed_at_ms: u64,
    expires_at_ms: u64,
    exit_code: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredEvidence {
    evidence: Evidence,
    evidence_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    repository: String,
    run_id: String,
    run_attempt: u64,
    head_sha: String,
    event: String,
    status: String,
    conclusion: String,
    workflow_path: String,
    artifact_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    expected: Identity,
    evaluated_at_ms: u64,
    candidate: Option<StoredEvidence>,
    provider: Option<Provider>,
}

fn fault(message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(
        "invalid-source-verification",
        "$",
        message,
    ))
}

fn parse<T: for<'de> Deserialize<'de>>(value: &Value) -> ContractResult<T> {
    serde_json::from_value(value.clone()).map_err(|error| fault(error.to_string()))
}

fn sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn validate_identity(identity: &Identity) -> ContractResult<()> {
    if identity.repository.split('/').count() != 2
        || identity.repository.split('/').any(str::is_empty)
        || !sha(&identity.source_sha)
        || !sha(&identity.source_tree)
        || !["linux-x64", "macos-arm64", "windows-x64"].contains(&identity.platform.as_str())
    {
        return Err(fault(
            "exact repository, commit, tree and supported platform are required",
        ));
    }
    for root in [
        &identity.workflow_root,
        &identity.check_definition_root,
        &identity.runtime_root,
        &identity.toolchain_root,
        &identity.dependency_root,
        &identity.environment_root,
    ] {
        validate_root(root, "$/identity")?;
    }
    Ok(())
}

fn validate_evidence(evidence: &Evidence) -> ContractResult<()> {
    validate_identity(&evidence.identity)?;
    if evidence.schema != SCHEMA
        || evidence.validation_kind != "full-source"
        || evidence.event != "merge_group"
        || evidence.run_id.is_empty()
        || !evidence.run_id.bytes().all(|c| c.is_ascii_digit())
        || evidence.run_attempt == 0
        || evidence.exit_code != 0
        || evidence.started_at_ms == 0
        || evidence.completed_at_ms < evidence.started_at_ms
        || evidence.expires_at_ms <= evidence.completed_at_ms
        || evidence.expires_at_ms - evidence.completed_at_ms > MAX_AGE_MS
    {
        return Err(fault(
            "only successful bounded full-source merge-group evidence can be sealed",
        ));
    }
    Ok(())
}

fn root(evidence: &Evidence) -> ContractResult<String> {
    content_root(
        "source-verification-evidence",
        &serde_json::to_value(evidence).map_err(|e| fault(e.to_string()))?,
    )
}

pub fn seal_source_verification(value: &Value) -> ContractResult<Value> {
    let evidence: Evidence = parse(value)?;
    validate_evidence(&evidence)?;
    Ok(json!({"evidenceRoot": root(&evidence)?, "evidence": evidence}))
}

pub fn plan_source_verification(value: &Value) -> ContractResult<Value> {
    let request: Request = parse(value)?;
    validate_identity(&request.expected)?;
    let execute = |reason: &str| json!({"decision":"execute", "reason":reason});
    let Some(candidate) = request.candidate else {
        return Ok(execute("missing-evidence"));
    };
    let Some(provider) = request.provider else {
        return Ok(execute("missing-provider-readback"));
    };
    validate_evidence(&candidate.evidence)?;
    if candidate.evidence_root != root(&candidate.evidence)? {
        return Ok(execute("root-mismatch"));
    }
    let evidence = candidate.evidence;
    if evidence.identity != request.expected {
        return Ok(execute("identity-mismatch"));
    }
    if request.evaluated_at_ms < evidence.completed_at_ms
        || request.evaluated_at_ms >= evidence.expires_at_ms
    {
        return Ok(execute("outside-validity-window"));
    }
    validate_root(&provider.artifact_digest, "$/provider/artifactDigest")?;
    if provider.repository != request.expected.repository
        || provider.run_id != evidence.run_id
        || provider.run_attempt != evidence.run_attempt
        || provider.head_sha != request.expected.source_sha
        || provider.event != "merge_group"
        || provider.status != "completed"
        || provider.conclusion != "success"
        || provider.workflow_path != ".github/workflows/verify.yml"
    {
        return Ok(execute("provider-mismatch"));
    }
    Ok(
        json!({"decision":"reuse", "reason":"exact-merge-group-evidence", "evidenceRoot":candidate.evidence_root,
        "runId":provider.run_id, "runAttempt":provider.run_attempt, "artifactDigest":provider.artifact_digest}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionProjection {
    base_version: String,
    version: String,
}

pub fn validate_source_version_projection(payload: &Value) -> ContractResult<Value> {
    let input: VersionProjection = parse(payload)?;
    let pattern =
        regex::Regex::new(r"^(4\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-alpha\.(0|[1-9][0-9]*)$")
            .map_err(|error| fault(error.to_string()))?;
    let matched = pattern
        .captures(&input.base_version)
        .ok_or_else(|| fault("base is not a v4 alpha version"))?;
    let sequence = matched[2]
        .parse::<u64>()
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| fault("alpha sequence overflow"))?;
    if input.version != format!("{}-alpha.{}", &matched[1], sequence) {
        return Err(fault(
            "only the exact next alpha version is a bounded projection",
        ));
    }
    Ok(json!({ "valid": true, "validationKind": "version-state-projection" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let r = format!("sha256:{}", "1".repeat(64));
        let identity = json!({"repository":"owner/repo", "sourceSha":"a".repeat(40), "sourceTree":"b".repeat(40),
            "workflowRoot":r, "checkDefinitionRoot":r, "runtimeRoot":r, "toolchainRoot":r,
            "dependencyRoot":r, "environmentRoot":r, "platform":"linux-x64"});
        let evidence = json!({"schema":SCHEMA, "identity":identity, "runId":"123", "runAttempt":1,
            "event":"merge_group", "validationKind":"full-source", "startedAtMs":1000,
            "completedAtMs":2000, "expiresAtMs":5000, "exitCode":0});
        json!({"expected":identity, "evaluatedAtMs":3000, "candidate":seal_source_verification(&evidence).unwrap(),
            "provider":{"repository":"owner/repo", "runId":"123", "runAttempt":1, "headSha":"a".repeat(40),
            "event":"merge_group", "status":"completed", "conclusion":"success",
            "workflowPath":".github/workflows/verify.yml", "artifactDigest":r}})
    }

    #[test]
    fn exact_identity_reuses_but_each_independent_binding_invalidates() {
        let original = fixture();
        assert_eq!(
            plan_source_verification(&original).unwrap()["decision"],
            "reuse"
        );
        for key in original["expected"].as_object().unwrap().keys() {
            let mut changed = original.clone();
            changed["expected"][key] = match key.as_str() {
                "repository" => json!("other/repo"),
                "sourceSha" | "sourceTree" => json!("c".repeat(40)),
                "platform" => json!("windows-x64"),
                _ => json!(format!("sha256:{}", "2".repeat(64))),
            };
            assert_eq!(
                plan_source_verification(&changed).unwrap()["decision"],
                "execute",
                "{key}"
            );
        }
    }

    #[test]
    fn missing_expired_corrupt_failed_or_wrong_provider_never_reuses() {
        for (pointer, value) in [
            ("/candidate", Value::Null),
            ("/provider", Value::Null),
            ("/evaluatedAtMs", json!(5000)),
            ("/evaluatedAtMs", json!(1999)),
            ("/candidate/evidenceRoot", json!("tampered")),
            ("/candidate/evidence/exitCode", json!(1)),
            ("/provider/conclusion", json!("failure")),
            ("/provider/event", json!("pull_request")),
            ("/provider/runAttempt", json!(2)),
            (
                "/provider/workflowPath",
                json!(".github/workflows/untrusted.yml"),
            ),
        ] {
            let mut changed = fixture();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(
                !plan_source_verification(&changed).is_ok_and(|v| v["decision"] == "reuse"),
                "{pointer}"
            );
        }
    }
}
