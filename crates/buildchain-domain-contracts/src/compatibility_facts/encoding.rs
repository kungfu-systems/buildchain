use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{ContractFault, ContractResult};

pub const KUNGFU_FACT_ROOT_PROTOCOL: &str = "kungfu.fact-root.canonical/v2";
pub const KUNGFU_TEMPORAL_BUNDLE_SCHEMA: &str = "kungfu.fact.temporal-bundle/v1";
pub const KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA: &str = "kungfu.fact.temporal-path-query/v1";
pub const KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA: &str = "kungfu.fact.temporal-path-receipt/v1";

pub(super) fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn schema_fields(schema: &str) -> Option<&'static [&'static str]> {
    match schema {
        "kungfu.fact.temporal-predicate/v1" => Some(&[
            "schema",
            "predicateId",
            "operations",
            "direction",
            "pathPolicy",
            "cyclePolicy",
            "authorityRoot",
        ]),
        "kungfu.fact.temporal-relation/v1" => Some(&[
            "schema",
            "relationId",
            "predicateRoot",
            "sourceRoot",
            "targetRoot",
            "validFromCutRoot",
            "scopeRoot",
            "authorityRoot",
            "admissionRoots",
        ]),
        "kungfu.fact.temporal-supersession/v1" => Some(&[
            "schema",
            "priorRelationRoot",
            "successorRelationRoot",
            "effectiveCutRoot",
            "reasonRoot",
            "authorityRoot",
            "admissionRoots",
        ]),
        "kungfu.fact.temporal-revocation/v1" => Some(&[
            "schema",
            "relationRoot",
            "effectiveCutRoot",
            "reasonRoot",
            "authorityRoot",
            "admissionRoots",
        ]),
        "kungfu.fact.temporal-authority-proof/v1" => Some(&[
            "schema",
            "proofId",
            "subjectAuthorityRoot",
            "governingAuthorityRoot",
            "operations",
            "validFromCutRoot",
            "revokedAtCutRoot",
            "admissionRoots",
        ]),
        KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA => Some(&[
            "schema",
            "queryId",
            "operation",
            "predicateRoot",
            "sourceRoot",
            "targetRoot",
            "cutRoot",
            "relationPathRoots",
            "requiredAuthorityRoot",
            "maxDepth",
        ]),
        KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA => Some(&[
            "schema",
            "queryRoot",
            "status",
            "failureCode",
            "cutRoot",
            "relationPathRoots",
            "authorityProofRoots",
            "omissionRoots",
        ]),
        _ => None,
    }
}

fn u64_bytes(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

fn encode_text(value: &str) -> Vec<u8> {
    let mut bytes = vec![0x20];
    bytes.extend(u64_bytes(value.len() as u64));
    bytes.extend(value.as_bytes());
    bytes
}

fn encode_collection(tag: u8, mut items: Vec<Vec<u8>>, set: bool) -> ContractResult<Vec<u8>> {
    if set {
        items.sort();
        if items.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(fault(
                "canonical-duplicate-item",
                "$",
                "set contains equal canonical items",
            ));
        }
    }
    let mut bytes = vec![tag];
    bytes.extend(u64_bytes(items.len() as u64));
    for item in items {
        bytes.extend(item);
    }
    Ok(bytes)
}

pub(super) fn is_root(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn text_field<'a>(
    record: &'a Map<String, Value>,
    field: &str,
) -> ContractResult<&'a str> {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() || field == "failureCode")
        .ok_or_else(|| {
            fault(
                "invalid-record",
                &format!("$.{field}"),
                "field must be text",
            )
        })
}

pub(super) fn root_field<'a>(
    record: &'a Map<String, Value>,
    field: &str,
) -> ContractResult<&'a str> {
    let value = text_field(record, field)?;
    if !is_root(value) {
        return Err(fault(
            "orphan-root",
            &format!("$.{field}"),
            "field must be a lowercase SHA-256 root",
        ));
    }
    Ok(value)
}

pub(super) fn string_array(
    record: &Map<String, Value>,
    field: &str,
) -> ContractResult<Vec<String>> {
    record
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            fault(
                "invalid-record",
                &format!("$.{field}"),
                "field must be an array",
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                fault(
                    "invalid-record",
                    &format!("$.{field}"),
                    "array item must be text",
                )
            })
        })
        .collect()
}

fn encode_field(record: &Map<String, Value>, field: &str) -> ContractResult<Vec<u8>> {
    if [
        "operations",
        "admissionRoots",
        "authorityProofRoots",
        "omissionRoots",
    ]
    .contains(&field)
    {
        let values = string_array(record, field)?;
        let mut items = Vec::new();
        for value in values {
            if field.ends_with("Roots") && !is_root(&value) {
                return Err(fault("orphan-root", &format!("$.{field}"), "invalid root"));
            }
            items.push(encode_text(&value));
        }
        return encode_collection(0x31, items, true);
    }
    if field == "relationPathRoots" {
        let values = string_array(record, field)?;
        if values.iter().any(|value| !is_root(value)) {
            return Err(fault("orphan-root", &format!("$.{field}"), "invalid root"));
        }
        return encode_collection(
            0x30,
            values.iter().map(|value| encode_text(value)).collect(),
            false,
        );
    }
    if field == "revokedAtCutRoot" && record.get(field) == Some(&Value::Null) {
        return Ok(vec![0]);
    }
    if field == "maxDepth" {
        let value = record
            .get(field)
            .and_then(Value::as_u64)
            .ok_or_else(|| fault("invalid-record", "$.maxDepth", "maxDepth must be unsigned"))?;
        let mut bytes = vec![0x10];
        bytes.extend(u64_bytes(value));
        return Ok(bytes);
    }
    let value = if field.ends_with("Root") {
        root_field(record, field)?
    } else {
        text_field(record, field)?
    };
    Ok(encode_text(value))
}

pub fn kungfu_temporal_record_root(record: &Value) -> ContractResult<String> {
    let object = record
        .as_object()
        .ok_or_else(|| fault("invalid-record", "$", "temporal record must be an object"))?;
    let schema = text_field(object, "schema")?;
    let fields = schema_fields(schema).ok_or_else(|| {
        fault(
            "canonical-unknown-schema",
            "$.schema",
            "unregistered temporal schema",
        )
    })?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(fault(
            "invalid-record",
            "$",
            "temporal record fields do not match its closed schema",
        ));
    }
    let mut descriptor = vec![0x40];
    descriptor.extend(encode_text(schema));
    descriptor.extend(u64_bytes(fields.len() as u64));
    for (index, field) in fields.iter().enumerate() {
        descriptor.extend(u64_bytes((index + 1) as u64));
        descriptor.extend(encode_field(object, field)?);
    }
    let mut hasher = Sha256::new();
    hasher.update(b"KFR2");
    hasher.update(descriptor);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}
