use serde_json::{Map, Value, json};

use crate::{ContractFault, ContractResult, content_root, validate_iso_timestamp, validate_root};

const INTENT_CONTRACT: &str = "kungfu-buildchain-v4-product-publication-intent/v1";
const PLAN_CONTRACT: &str = "kungfu-buildchain-v4-product-publication-plan/v1";
const DECLARATION_CONTRACT: &str = "kungfu-buildchain-release-tail-capabilities";
const TRANSACTION_POLICY: &str = "buildchain.release-tail/v1";
const EFFECT_SCHEMA: &str = "kungfu.buildchain.release-tail.effect/v1";
const OBSERVATION_SCHEMA: &str = "kungfu.buildchain.release-tail.observation/v1";
const RECEIPT_SCHEMA: &str = "kungfu.buildchain.release-tail.receipt/v1";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Version {
    value: String,
    major: u64,
    minor: u64,
    patch: u64,
    alpha: Option<u64>,
}

fn fault(message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(
        "invalid-product-publication",
        "$",
        format!("invalid v4 product publication: {}", message.into()),
    ))
}

fn object(value: &Value) -> ContractResult<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| fault("input must be an object"))
}

fn string(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn required_string(value: &Value, name: &str) -> ContractResult<String> {
    let value = string(value, name);
    if value.is_empty() {
        return Err(fault(format!("{name} must be a non-empty string")));
    }
    Ok(value)
}

fn required_root(value: &Value, name: &str) -> ContractResult<String> {
    let root = required_string(value, name)?.to_ascii_lowercase();
    validate_root(&root, &format!("$/{name}"))
        .map_err(|_| fault(format!("{name} must be a sha256 content root")))?;
    Ok(root)
}

fn parse_numeric(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn parse_version(value: &str, label: &str) -> ContractResult<Version> {
    let (stable, alpha) = match value.split_once("-alpha.") {
        Some((stable, alpha)) => (stable, Some(alpha)),
        None => (value, None),
    };
    let parts = stable.split('.').collect::<Vec<_>>();
    let invalid = || fault(format!("{label} must be an exact stable or alpha version"));
    if parts.len() != 3 || alpha.is_some_and(|value| value.contains('-') || value.contains('.')) {
        return Err(invalid());
    }
    let major = parse_numeric(parts[0]).ok_or_else(&invalid)?;
    let minor = parse_numeric(parts[1]).ok_or_else(&invalid)?;
    let patch = parse_numeric(parts[2]).ok_or_else(&invalid)?;
    let alpha = alpha
        .map(|value| parse_numeric(value).ok_or_else(&invalid))
        .transpose()?;
    Ok(Version {
        value: value.to_owned(),
        major,
        minor,
        patch,
        alpha,
    })
}

fn channel(value: &str) -> ContractResult<&'static str> {
    match value {
        "alpha" => Ok("alpha"),
        "release" | "stable" | "major" => Ok("stable"),
        _ => Err(fault(format!("unsupported channel '{value}'"))),
    }
}

fn assert_lane(channel: &str, target_ref: &str, version: &Version) -> ContractResult<()> {
    let prefix = if channel == "alpha" {
        "alpha"
    } else {
        "release"
    };
    let expected = format!(
        "{prefix}/v{}/v{}.{}",
        version.major, version.major, version.minor
    );
    if target_ref != expected {
        return Err(fault(format!(
            "target ref '{target_ref}' is not a {channel} lane or does not match the publication version line"
        )));
    }
    Ok(())
}

fn exact_git_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn repository(value: &str) -> bool {
    let parts = value.split('/').collect::<Vec<_>>();
    parts.len() == 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && !part.chars().any(char::is_whitespace))
}

fn observed_alpha(value: &str, expected: &Version) -> Option<u64> {
    let parsed = parse_version(value, "observed").ok()?;
    (parsed.major == expected.major
        && parsed.minor == expected.minor
        && parsed.patch == expected.patch)
        .then_some(parsed.alpha)
        .flatten()
}

pub fn select_product_publication_intent(value: &Value) -> ContractResult<Value> {
    let _ = object(value)?;
    let normalized_channel = channel(&string(value, "channel"))?;
    let target_ref = string(value, "targetRef");
    let source_sha = string(value, "sourceSha");
    if !exact_git_sha(&source_sha) {
        return Err(fault("sourceSha must be an exact Git SHA"));
    }
    let source_timestamp = required_string(value, "sourceTimestamp")?;
    if !validate_iso_timestamp(&source_timestamp) {
        return Err(fault("sourceTimestamp must be an ISO timestamp"));
    }
    let repository_name = string(value, "repository");
    if !repository(&repository_name) {
        return Err(fault("repository must be owner/repo"));
    }
    let artifact_kind = match string(value, "artifactKind").as_str() {
        "" | "npm" => "npm",
        "custom" => "custom",
        kind => return Err(fault(format!("unsupported artifactKind '{kind}'"))),
    };
    let package_name = (artifact_kind == "npm")
        .then(|| required_string(value, "packageName"))
        .transpose()?;
    let dist_tag = if artifact_kind == "npm" {
        let tag = required_string(value, "distTag")?;
        if !tag.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && b"._-".contains(&byte))
        }) {
            return Err(fault("distTag must be an npm dist-tag"));
        }
        Some(tag)
    } else {
        None
    };
    let sealed_bundle_root = (artifact_kind == "npm")
        .then(|| required_root(value, "sealedBundleRoot"))
        .transpose()?;
    let required_artifacts_root = required_root(value, "requiredArtifactsRoot")?;
    let candidate = parse_version(&string(value, "candidateVersion"), "candidateVersion")?;
    assert_lane(normalized_channel, &target_ref, &candidate)?;
    let observed_values = value
        .get("observedVersions")
        .and_then(Value::as_array)
        .ok_or_else(|| fault("observedVersions must be an array"))?;
    let mut observed = observed_values
        .iter()
        .map(|entry| match entry {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>();
    observed.sort();
    observed.dedup();
    let recovered = string(value, "recoveredVersion");
    let (version, mode) = if !recovered.is_empty() {
        let recovered = parse_version(&recovered, "recoveredVersion")?;
        if recovered.major != candidate.major
            || recovered.minor != candidate.minor
            || recovered.patch != candidate.patch
            || (normalized_channel == "alpha" && recovered.alpha.is_none())
            || (normalized_channel == "stable" && recovered.alpha.is_some())
        {
            return Err(fault(
                "recoveredVersion is incompatible with the candidate release line",
            ));
        }
        (recovered.value, "resume")
    } else if normalized_channel == "alpha" {
        let alpha = candidate
            .alpha
            .ok_or_else(|| fault("fresh alpha publication requires an alpha candidate version"))?;
        if artifact_kind == "custom" {
            (candidate.value.clone(), "fresh")
        } else {
            let highest = observed
                .iter()
                .filter_map(|entry| observed_alpha(entry, &candidate))
                .fold(alpha, u64::max);
            (
                format!(
                    "{}.{}.{}-alpha.{}",
                    candidate.major,
                    candidate.minor,
                    candidate.patch,
                    highest + 1
                ),
                "fresh",
            )
        }
    } else {
        (
            format!(
                "{}.{}.{}",
                candidate.major, candidate.minor, candidate.patch
            ),
            "fresh",
        )
    };
    let mut intent = Map::new();
    intent.insert("schema".to_owned(), json!(INTENT_CONTRACT));
    intent.insert("mode".to_owned(), json!(mode));
    intent.insert("channel".to_owned(), json!(normalized_channel));
    intent.insert("targetRef".to_owned(), json!(target_ref));
    intent.insert("sourceSha".to_owned(), json!(source_sha));
    intent.insert("sourceTimestamp".to_owned(), json!(source_timestamp));
    intent.insert("repository".to_owned(), json!(repository_name));
    if artifact_kind == "custom" {
        intent.insert("artifactKind".to_owned(), json!("custom"));
    } else {
        intent.insert("packageName".to_owned(), json!(package_name));
        intent.insert("distTag".to_owned(), json!(dist_tag));
        intent.insert("sealedBundleRoot".to_owned(), json!(sealed_bundle_root));
    }
    intent.insert(
        "requiredArtifactsRoot".to_owned(),
        json!(required_artifacts_root),
    );
    intent.insert("candidateVersion".to_owned(), json!(candidate.value));
    intent.insert("version".to_owned(), json!(version));
    intent.insert("exactTag".to_owned(), json!(format!("v{version}")));
    intent.insert("observedVersions".to_owned(), json!(observed));
    let intent_value = Value::Object(intent);
    let root = content_root("v4-product-publication-intent", &intent_value)?;
    let mut output = intent_value.as_object().cloned().unwrap_or_default();
    output.insert("intentRoot".to_owned(), json!(root));
    Ok(Value::Object(output))
}

fn selected_from_intent(intent: &Value) -> ContractResult<Value> {
    let mut input = Map::new();
    for name in [
        "channel",
        "targetRef",
        "sourceSha",
        "sourceTimestamp",
        "repository",
        "artifactKind",
        "packageName",
        "distTag",
        "sealedBundleRoot",
        "requiredArtifactsRoot",
        "candidateVersion",
        "observedVersions",
    ] {
        if let Some(value) = intent.get(name) {
            input.insert(name.to_owned(), value.clone());
        }
    }
    input.insert(
        "recoveredVersion".to_owned(),
        if intent.get("mode").and_then(Value::as_str) == Some("resume") {
            intent.get("version").cloned().unwrap_or(Value::Null)
        } else {
            json!("")
        },
    );
    select_product_publication_intent(&Value::Object(input))
}

fn references(intent: &Value, version: &Version) -> Value {
    let tag = intent
        .get("exactTag")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target_ref = intent
        .get("targetRef")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut values = vec![
        json!({"ref": format!("refs/tags/{tag}"), "target": "source"}),
        json!({"ref": format!("refs/heads/{target_ref}"), "target": "version-state"}),
    ];
    if intent.get("channel").and_then(Value::as_str) == Some("alpha") {
        values.extend([
            json!({"ref": format!("refs/heads/dev/v{}/v{}.{}", version.major, version.major, version.minor), "target": "version-state"}),
            json!({"ref": format!("refs/tags/v{}.{}-alpha", version.major, version.minor), "target": "version-state"}),
            json!({"ref": format!("refs/tags/v{}-alpha", version.major), "target": "version-state"}),
        ]);
    } else {
        values.extend([
            json!({"ref": format!("refs/tags/v{}.{}", version.major, version.minor), "target": "version-state"}),
            json!({"ref": format!("refs/tags/v{}", version.major), "target": "version-state"}),
        ]);
    }
    Value::Array(values)
}

pub fn create_product_publication_plan(value: &Value) -> ContractResult<Value> {
    let intent = value
        .get("intent")
        .ok_or_else(|| fault("intent is required"))?;
    let invocation_root = required_root(value, "invocationRoot")?;
    let transaction_root = required_root(value, "transactionRoot")?;
    let selected = selected_from_intent(intent)?;
    if selected.get("intentRoot") != intent.get("intentRoot") {
        return Err(fault(
            "intentRoot does not match the canonical publication intent",
        ));
    }
    let version = parse_version(&string(intent, "version"), "intent.version")?;
    let source_sha = string(intent, "sourceSha");
    let state_ref = format!(
        "refs/heads/buildchain/v4-product-state/{}-{}",
        source_sha,
        version.value.replace('.', "-")
    );
    let mut operations = vec![json!({
        "id": "product.version-state.materialize",
        "adapter": "github-version-state",
        "authority": "contents-write",
        "target": {
            "repository": intent.get("repository"),
            "version": version.value,
            "sourceSha": source_sha,
            "sourceTimestamp": intent.get("sourceTimestamp"),
            "stateRef": state_ref,
        },
    })];
    if intent.get("artifactKind").and_then(Value::as_str) != Some("custom") {
        operations.push(json!({
            "id": "product.package.publish",
            "adapter": "npm-trusted-publishing",
            "authority": "oidc-provider-mutation",
            "target": {
                "packageName": intent.get("packageName"),
                "version": version.value,
                "distTag": intent.get("distTag"),
                "sealedBundleRoot": intent.get("sealedBundleRoot"),
                "requiredArtifactsRoot": intent.get("requiredArtifactsRoot"),
            },
        }));
    }
    operations.push(json!({
        "id": "product.release-refs.converge",
        "adapter": "github-release-refs",
        "authority": "contents-write",
        "target": {
            "repository": intent.get("repository"),
            "sourceSha": source_sha,
            "stateRef": state_ref,
            "references": references(intent, &version),
        },
    }));
    for operation in &mut operations {
        let root = content_root("v4-product-publication-operation", operation)?;
        operation
            .as_object_mut()
            .expect("operation object")
            .insert("operationRoot".to_owned(), json!(root));
    }
    let operation_order = operations
        .iter()
        .filter_map(|operation| operation.get("id"))
        .cloned()
        .collect::<Vec<_>>();
    let plan = json!({
        "schema": PLAN_CONTRACT,
        "intentRoot": intent.get("intentRoot"),
        "invocationRoot": invocation_root,
        "transactionRoot": transaction_root,
        "operationOrder": operation_order,
        "operations": operations,
    });
    let plan_root = content_root("v4-product-publication-plan", &plan)?;
    let mut output = plan.as_object().cloned().unwrap_or_default();
    output.insert("planRoot".to_owned(), json!(plan_root));
    Ok(Value::Object(output))
}

fn descriptor(id: &str) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match id {
        "product.version-state.materialize" => Some((
            "github-version-state",
            "product-version-state-materialization",
            "product-version-state-readback",
            "product-version-state",
        )),
        "product.package.publish" => Some((
            "npm-package",
            "product-package-publication",
            "product-package-readback",
            "product-package-publication",
        )),
        "product.release-refs.converge" => Some((
            "github-release-refs",
            "product-release-ref-convergence",
            "product-release-ref-readback",
            "product-release-ref-convergence",
        )),
        _ => None,
    }
}

fn exact_tag_pattern(tag: &str) -> String {
    let mut result = String::from("^");
    for character in tag.chars() {
        if ".*+?^${}()|[]\\".contains(character) {
            result.push('\\');
        }
        result.push(character);
    }
    result.push('$');
    result
}

pub fn create_product_publication_declaration(value: &Value) -> ContractResult<Value> {
    let intent = value
        .get("intent")
        .ok_or_else(|| fault("intent is required"))?;
    let plan = value.get("plan").ok_or_else(|| fault("plan is required"))?;
    let rebuilt = create_product_publication_plan(&json!({
        "intent": intent,
        "invocationRoot": plan.get("invocationRoot"),
        "transactionRoot": plan.get("transactionRoot"),
    }))?;
    if rebuilt.get("planRoot") != plan.get("planRoot") {
        return Err(fault(
            "planRoot does not match the canonical publication plan",
        ));
    }
    let mut capabilities = Vec::new();
    for id in plan
        .get("operationOrder")
        .and_then(Value::as_array)
        .ok_or_else(|| fault("plan.operationOrder must be an array"))?
    {
        let id = id.as_str().unwrap_or_default();
        let operation = plan
            .get("operations")
            .and_then(Value::as_array)
            .and_then(|operations| {
                operations
                    .iter()
                    .find(|operation| operation.get("id").and_then(Value::as_str) == Some(id))
            });
        let Some((destination_kind, effect_kind, observation_kind, receipt_kind)) = descriptor(id)
        else {
            return Err(fault(format!(
                "unsupported product publication operation '{id}'"
            )));
        };
        let operation = operation
            .ok_or_else(|| fault(format!("unsupported product publication operation '{id}'")))?;
        let mut artifact_roles =
            vec![json!({"role": "publication-intent", "root": intent.get("intentRoot")})];
        if id == "product.package.publish" {
            artifact_roles.extend([
                json!({"role": "sealed-bundle", "root": intent.get("sealedBundleRoot")}),
                json!({"role": "required-artifacts", "root": intent.get("requiredArtifactsRoot")}),
            ]);
        }
        capabilities.push(json!({
            "id": id,
            "executor": "provider-adapter",
            "adapter": operation.get("adapter"),
            "artifactRoles": artifact_roles,
            "destination": {
                "kind": destination_kind,
                "locator": format!("{}:{}", operation.get("adapter").and_then(Value::as_str).unwrap_or_default(), operation.get("operationRoot").and_then(Value::as_str).unwrap_or_default()),
            },
            "channelPolicy": {
                "channel": intent.get("channel"),
                "tagPattern": exact_tag_pattern(intent.get("exactTag").and_then(Value::as_str).unwrap_or_default()),
                "authorityMove": if id == "product.package.publish" { "none" } else { "verified-ref" },
            },
            "activationPolicy": {"mode": "none", "environment": "none"},
            "readbackPredicates": [{"id": format!("{id}.target-root"), "kind": "exact-root", "expected": operation.get("operationRoot")}],
            "effect": {"schema": EFFECT_SCHEMA, "kind": effect_kind},
            "observation": {"schema": OBSERVATION_SCHEMA, "kind": observation_kind},
            "receipt": {"schema": RECEIPT_SCHEMA, "kind": receipt_kind},
            "operationIdentity": {
                "transactionRoot": plan.get("transactionRoot"),
                "capabilityId": id,
                "subjectRoot": intent.get("intentRoot"),
                "targetRoot": operation.get("operationRoot"),
                "attemptKey": format!("{}:{id}", plan.get("planRoot").and_then(Value::as_str).unwrap_or_default()),
            },
            "idempotency": {"scope": "subject-target", "duplicate": "readback-before-retry"},
            "retry": {"class": "provider-transient", "localAttempts": 1, "exhausted": "blocked"},
            "evidenceRequirements": ["provider readback must match the rooted publication operation"],
        }));
    }
    Ok(json!({
        "contract": DECLARATION_CONTRACT,
        "schemaVersion": 1,
        "transactionPolicy": TRANSACTION_POLICY,
        "subject": {
            "repository": intent.get("repository"),
            "sourceSha": intent.get("sourceSha"),
            "version": intent.get("version"),
            "tag": intent.get("exactTag"),
            "channel": intent.get("channel"),
        },
        "capabilities": capabilities,
    }))
}
