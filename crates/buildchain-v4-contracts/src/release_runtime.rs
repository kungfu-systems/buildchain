use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::{
    ContractFault, ContractResult, content_root, project_release_invocation, validate_root,
};

const RELEASE_INVOCATION_ADAPTER_CONTRACT: &str =
    "kungfu-buildchain-v4-release-invocation-adapter/v1";
const RELEASE_TRANSACTION_CONTRACT: &str = "kungfu-buildchain-v4-release-transaction/v1";
const RELEASE_RECEIPT_CONTRACT: &str = "kungfu-buildchain-v4-release-receipt/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn object<'a>(value: &'a Value, path: &str) -> ContractResult<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        fault(
            "invalid-release-shape",
            path,
            format!("{path} must be an object"),
        )
    })
}

fn exact_keys(value: &Value, expected: &[&str], path: &str) -> ContractResult<()> {
    let map = object(value, path)?;
    let actual = map.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(fault(
            "invalid-release-shape",
            path,
            format!("{path} keys are not canonical"),
        ));
    }
    Ok(())
}

fn field<'a>(value: &'a Value, name: &str, path: &str) -> ContractResult<&'a Value> {
    object(value, path)?.get(name).ok_or_else(|| {
        fault(
            "invalid-release-shape",
            path,
            format!("{path}/{name} is required"),
        )
    })
}

fn text<'a>(value: &'a Value, path: &str) -> ContractResult<&'a str> {
    let value = value.as_str().ok_or_else(|| {
        fault(
            "invalid-release-text",
            path,
            format!("{path} must be printable ASCII"),
        )
    })?;
    if value.is_empty() || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err(fault(
            "invalid-release-text",
            path,
            format!("{path} must be printable ASCII"),
        ));
    }
    Ok(value)
}

fn sha(value: &Value, path: &str) -> ContractResult<String> {
    let value = value.as_str().ok_or_else(|| {
        fault(
            "invalid-release-sha",
            path,
            format!("{path} must be an exact Git SHA"),
        )
    })?;
    if value.len() != 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(fault(
            "invalid-release-sha",
            path,
            format!("{path} must be an exact Git SHA"),
        ));
    }
    Ok(value.to_owned())
}

fn release_lane(target: &str) -> Option<&'static str> {
    if ["publish-gate/major", "major-gate"].contains(&target) {
        return Some("stable");
    }
    let parts = target.split('/').collect::<Vec<_>>();
    if parts.len() != 3 || !parts[1].starts_with('v') || !parts[2].starts_with('v') {
        return None;
    }
    let major = &parts[1][1..];
    let version = &parts[2][1..];
    let version_parts = version.split('.').collect::<Vec<_>>();
    if major.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || version_parts.len() != 2
        || version_parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
        || version_parts[0] != major
    {
        return None;
    }
    match parts[0] {
        "alpha" => Some("alpha"),
        "release" => Some("stable"),
        _ => None,
    }
}

pub fn adapt_release_invocation(value: &Value) -> ContractResult<Value> {
    exact_keys(value, &["schema", "route", "invocation"], "$adapter")?;
    if field(value, "schema", "$adapter")?.as_str() != Some(RELEASE_INVOCATION_ADAPTER_CONTRACT) {
        return Err(fault(
            "invalid-release-adapter",
            "$adapter/schema",
            "unsupported adapter schema",
        ));
    }
    let route = field(value, "route", "$adapter")?;
    exact_keys(route, &["surface", "execution"], "$adapter/route")?;
    let surface = field(route, "surface", "$adapter/route")?.as_str();
    if !matches!(
        surface,
        Some("alpha" | "stable" | "public" | "private" | "declarative" | "legacy-compatible")
    ) {
        return Err(fault(
            "invalid-release-adapter",
            "$adapter/route/surface",
            "unsupported route surface",
        ));
    }
    if !matches!(
        field(route, "execution", "$adapter/route")?.as_str(),
        Some("fresh" | "resume")
    ) {
        return Err(fault(
            "invalid-release-adapter",
            "$adapter/route/execution",
            "unsupported execution mode",
        ));
    }
    let invocation = serde_json::from_value(field(value, "invocation", "$adapter")?.clone())
        .map_err(|error| fault("invalid-release-invocation-shape", "$", error.to_string()))?;
    serde_json::to_value(project_release_invocation(invocation)?)
        .map_err(|error| fault("release-serialization-failed", "$", error.to_string()))
}

pub fn plan_release_route(value: &Value) -> ContractResult<Value> {
    exact_keys(
        value,
        &[
            "requestedSha",
            "observedSha",
            "comparisonStatus",
            "requestedChannel",
            "targetRef",
            "dryRun",
            "resume",
        ],
        "$route",
    )?;
    let requested_sha = sha(
        field(value, "requestedSha", "$route")?,
        "$route/requestedSha",
    )?;
    let observed_sha = sha(field(value, "observedSha", "$route")?, "$route/observedSha")?;
    let comparison = field(value, "comparisonStatus", "$route")?
        .as_str()
        .unwrap_or_default();
    if !["identical", "ahead", "behind", "diverged"].contains(&comparison) {
        return Err(fault(
            "invalid-release-route",
            "$route/comparisonStatus",
            "unsupported source comparison state",
        ));
    }
    let target_ref = text(field(value, "targetRef", "$route")?, "$route/targetRef")?;
    let derived_channel = release_lane(target_ref).ok_or_else(|| {
        fault(
            "invalid-release-route",
            "$route/targetRef",
            "source lane is not a supported v4 release lane",
        )
    })?;
    let requested_channel = field(value, "requestedChannel", "$route")?
        .as_str()
        .unwrap_or_default();
    let normalized = match requested_channel {
        "alpha" => "alpha",
        "release" | "stable" | "major" => "stable",
        "" => derived_channel,
        _ => "",
    };
    if normalized != derived_channel {
        return Err(fault(
            "invalid-release-route",
            "$route/channel",
            "requested channel does not match the source lane",
        ));
    }
    let dry_run = field(value, "dryRun", "$route")?.as_bool().ok_or_else(|| {
        fault(
            "invalid-release-route",
            "$route/dryRun",
            "dryRun must be boolean",
        )
    })?;
    let resume = field(value, "resume", "$route")?.as_bool().ok_or_else(|| {
        fault(
            "invalid-release-route",
            "$route/resume",
            "resume must be boolean",
        )
    })?;
    let (decision, reason) = if comparison == "ahead" && !resume && !dry_run {
        ("NoOp", "source-advanced".to_owned())
    } else if requested_sha != observed_sha
        && !(resume && comparison == "ahead")
        && !(dry_run && comparison == "ahead")
    {
        ("Blocked", format!("source-{comparison}"))
    } else if resume {
        ("Resume", "resume".to_owned())
    } else {
        ("Fresh", "fresh".to_owned())
    };
    Ok(json!({
        "decision": decision,
        "reason": reason,
        "channel": normalized,
        "targetRef": target_ref,
        "requestedSha": requested_sha,
        "observedSha": observed_sha,
    }))
}

pub fn create_release_transaction(value: &Value) -> ContractResult<Value> {
    let names = [
        "invocationRoot",
        "publisherRoot",
        "runtimeRoot",
        "providerRoot",
        "parentRoot",
    ];
    exact_keys(value, &names, "$transaction")?;
    for name in names {
        validate_root(
            field(value, name, "$transaction")?
                .as_str()
                .unwrap_or_default(),
            &format!("$transaction/{name}"),
        )?;
    }
    let transaction = json!({
        "schema": RELEASE_TRANSACTION_CONTRACT,
        "invocationRoot": field(value, "invocationRoot", "$transaction")?,
        "publisherRoot": field(value, "publisherRoot", "$transaction")?,
        "runtimeRoot": field(value, "runtimeRoot", "$transaction")?,
        "providerRoot": field(value, "providerRoot", "$transaction")?,
        "parentRoot": field(value, "parentRoot", "$transaction")?,
        "phases": ["QUALIFY", "APPLY", "SETTLE"],
        "writer": "canonical-v4-apply",
    });
    Ok(json!({
        "transactionRoot": content_root("release-transaction", &transaction)?,
        "transaction": transaction,
    }))
}

pub fn create_release_receipt(value: &Value) -> ContractResult<Value> {
    exact_keys(
        value,
        &[
            "schema",
            "transactionRoot",
            "outcome",
            "releasePassportRoot",
            "providerTransactionRoot",
            "providerStateRoot",
            "providerReceiptRoots",
        ],
        "$receipt",
    )?;
    if field(value, "schema", "$receipt")?.as_str() != Some(RELEASE_RECEIPT_CONTRACT) {
        return Err(fault(
            "invalid-release-receipt",
            "$receipt/schema",
            "unsupported receipt schema",
        ));
    }
    validate_root(
        field(value, "transactionRoot", "$receipt")?
            .as_str()
            .unwrap_or_default(),
        "$receipt/transactionRoot",
    )?;
    let outcome = field(value, "outcome", "$receipt")?
        .as_str()
        .unwrap_or_default();
    if !["complete", "blocked"].contains(&outcome) {
        return Err(fault(
            "invalid-release-receipt",
            "$receipt/outcome",
            "unsupported receipt outcome",
        ));
    }
    for name in [
        "releasePassportRoot",
        "providerTransactionRoot",
        "providerStateRoot",
    ] {
        let root = field(value, name, "$receipt")?;
        if !root.is_null() {
            validate_root(
                root.as_str().unwrap_or_default(),
                &format!("$receipt/{name}"),
            )?;
        }
    }
    let roots = field(value, "providerReceiptRoots", "$receipt")?
        .as_array()
        .ok_or_else(|| {
            fault(
                "invalid-release-receipt",
                "$receipt/providerReceiptRoots",
                "receipt roots must be an array",
            )
        })?;
    let mut canonical = Vec::with_capacity(roots.len());
    for (index, root) in roots.iter().enumerate() {
        let root = root.as_str().unwrap_or_default();
        validate_root(root, &format!("$receipt/providerReceiptRoots/{index}"))?;
        canonical.push(root.to_owned());
    }
    let mut sorted = canonical.clone();
    sorted.sort();
    sorted.dedup();
    if sorted != canonical {
        return Err(fault(
            "invalid-release-receipt",
            "$receipt/providerReceiptRoots",
            "provider receipt roots must be sorted and unique",
        ));
    }
    if outcome == "complete"
        && [
            "releasePassportRoot",
            "providerTransactionRoot",
            "providerStateRoot",
        ]
        .iter()
        .any(|name| field(value, name, "$receipt").is_ok_and(Value::is_null))
    {
        return Err(fault(
            "invalid-release-receipt",
            "$receipt/outcome",
            "complete receipt requires every terminal root",
        ));
    }
    let _ = crate::canonical_bytes(value)?;
    Ok(json!({
        "receiptRoot": content_root("release-receipt", value)?,
        "receipt": value,
    }))
}
