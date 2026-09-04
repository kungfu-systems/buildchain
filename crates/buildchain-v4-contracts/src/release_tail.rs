use std::collections::BTreeSet;

use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{ContractFault, ContractResult, canonical_bytes, validate_root};

const DECLARATION_CONTRACT: &str = "kungfu-buildchain-release-tail-capabilities";
const TRANSACTION_POLICY: &str = "buildchain.release-tail/v1";
const PLAN_SCHEMA: &str = "kungfu.buildchain.release-tail.effect-plan/v1";
const TRANSACTION_SCHEMA: &str = "kungfu.buildchain.release-tail.transaction/v1";
const EFFECT_SCHEMA: &str = "kungfu.buildchain.release-tail.effect/v1";
const OBSERVATION_SCHEMA: &str = "kungfu.buildchain.release-tail.observation/v1";
const RECEIPT_SCHEMA: &str = "kungfu.buildchain.release-tail.receipt/v1";

const STATES: &[&str] = &[
    "preparing",
    "prepared",
    "publishing",
    "committing",
    "activating",
    "reading-back",
    "settling",
    "complete",
    "blocked",
    "repair-required",
    "terminal-failure",
];
const TERMINAL_STATES: &[&str] = &["complete", "blocked", "repair-required", "terminal-failure"];
const FORBIDDEN_KEYS: &[&str] = &[
    "cmd",
    "command",
    "eval",
    "executable",
    "javascript",
    "run",
    "script",
    "shell",
];
const SUBJECT_FIELDS: &[&str] = &["repository", "sourceSha", "version", "tag", "channel"];
const EFFECT_FIELDS: &[&str] = &[
    "schema",
    "kind",
    "transactionRoot",
    "operationId",
    "capabilityId",
    "executor",
    "adapter",
    "subjectRoot",
    "targetRoot",
    "attemptKey",
    "subject",
    "artifactRoles",
    "destination",
    "channelPolicy",
    "activationPolicy",
    "readbackPredicates",
    "idempotency",
    "retry",
    "evidenceRequirements",
    "effectRoot",
];

#[derive(Clone, Copy)]
struct Descriptor {
    id: &'static str,
    executor: &'static str,
    adapter: &'static str,
    effect_kind: &'static str,
    observation_kind: &'static str,
    receipt_kind: &'static str,
    transaction_state: &'static str,
}

const DESCRIPTORS: &[Descriptor] = &[
    Descriptor {
        id: "product.version-state.materialize",
        executor: "provider-adapter",
        adapter: "github-version-state",
        effect_kind: "product-version-state-materialization",
        observation_kind: "product-version-state-readback",
        receipt_kind: "product-version-state",
        transaction_state: "preparing",
    },
    Descriptor {
        id: "product.package.publish",
        executor: "provider-adapter",
        adapter: "npm-trusted-publishing",
        effect_kind: "product-package-publication",
        observation_kind: "product-package-readback",
        receipt_kind: "product-package-publication",
        transaction_state: "publishing",
    },
    Descriptor {
        id: "product.release-refs.converge",
        executor: "provider-adapter",
        adapter: "github-release-refs",
        effect_kind: "product-release-ref-convergence",
        observation_kind: "product-release-ref-readback",
        receipt_kind: "product-release-ref-convergence",
        transaction_state: "committing",
    },
    Descriptor {
        id: "artifact.publish",
        executor: "provider-adapter",
        adapter: "github-release-assets",
        effect_kind: "artifact-publication",
        observation_kind: "artifact-publication-readback",
        receipt_kind: "artifact-publication",
        transaction_state: "publishing",
    },
    Descriptor {
        id: "signed-channel.commit",
        executor: "provider-adapter",
        adapter: "signed-static-channel",
        effect_kind: "signed-channel-commit",
        observation_kind: "signed-channel-readback",
        receipt_kind: "publication-commit",
        transaction_state: "committing",
    },
    Descriptor {
        id: "release.activate",
        executor: "provider-adapter",
        adapter: "site-release-activation",
        effect_kind: "release-activation",
        observation_kind: "production-readback",
        receipt_kind: "activation-receipt-set",
        transaction_state: "activating",
    },
    Descriptor {
        id: "released-evidence.synthesize",
        executor: "buildchain-core",
        adapter: "activation-receipt-projector",
        effect_kind: "released-evidence-projection",
        observation_kind: "released-evidence-validation",
        receipt_kind: "released-evidence",
        transaction_state: "settling",
    },
];

fn descriptor(id: &str) -> Option<Descriptor> {
    DESCRIPTORS.iter().copied().find(|entry| entry.id == id)
}

fn fault(message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(
        "invalid-release-tail",
        "$",
        format!("invalid release-tail declaration: {}", message.into()),
    ))
}

fn object<'a>(value: &'a Value, label: &str) -> ContractResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| fault(format!("{label} must be an object")))
}

fn exact_fields(value: &Value, fields: &[&str], label: &str) -> ContractResult<()> {
    let actual = object(value, label)?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = fields.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(fault(format!(
            "{label} fields must be exactly: {}",
            fields.join(", ")
        )));
    }
    Ok(())
}

fn non_empty<'a>(value: &'a Value, label: &str) -> ContractResult<&'a str> {
    let value = value.as_str().unwrap_or_default();
    if value.trim().is_empty() {
        return Err(fault(format!("{label} must be a non-empty string")));
    }
    Ok(value)
}

fn exact_root(value: &Value, label: &str) -> ContractResult<String> {
    let value = non_empty(value, label)?.to_ascii_lowercase();
    validate_root(&value, label)
        .map_err(|_| fault(format!("{label} must be a sha256 content root")))?;
    Ok(value)
}

fn reject_executable_keys(value: &Value, pointer: &str) -> ContractResult<()> {
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_executable_keys(value, &format!("{pointer}/{index}"))?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if FORBIDDEN_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
                    return Err(fault(format!(
                        "executable key '{key}' is forbidden at {pointer}"
                    )));
                }
                reject_executable_keys(value, &format!("{pointer}/{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_message(
    value: &Value,
    schema: &str,
    kind: &str,
    label: &str,
) -> ContractResult<Value> {
    exact_fields(value, &["kind", "schema"], label)?;
    if value.get("schema").and_then(Value::as_str) != Some(schema) {
        return Err(fault(format!("{label}.schema is not supported")));
    }
    if value.get("kind").and_then(Value::as_str) != Some(kind) {
        return Err(fault(format!("{label}.kind must be {kind}")));
    }
    Ok(json!({"kind": kind, "schema": schema}))
}

fn normalize_capability(value: &Value, subject: &Value) -> ContractResult<Value> {
    const FIELDS: &[&str] = &[
        "id",
        "executor",
        "adapter",
        "artifactRoles",
        "destination",
        "channelPolicy",
        "activationPolicy",
        "readbackPredicates",
        "effect",
        "observation",
        "receipt",
        "operationIdentity",
        "idempotency",
        "retry",
        "evidenceRequirements",
    ];
    let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
    exact_fields(value, FIELDS, &format!("capability {id}"))?;
    let spec = descriptor(id).ok_or_else(|| fault(format!("unsupported capability id: {id}")))?;
    if value.get("executor").and_then(Value::as_str) != Some(spec.executor) {
        return Err(fault(format!("{id}.executor must be {}", spec.executor)));
    }
    if value.get("adapter").and_then(Value::as_str) != Some(spec.adapter) {
        return Err(fault(format!("{id}.adapter must be {}", spec.adapter)));
    }
    let artifact_roles = value
        .get("artifactRoles")
        .and_then(Value::as_array)
        .ok_or_else(|| fault(format!("{id}.artifactRoles must be an array")))?;
    let mut roles = Vec::new();
    let mut role_ids = BTreeSet::new();
    for (index, entry) in artifact_roles.iter().enumerate() {
        exact_fields(
            entry,
            &["role", "root"],
            &format!("{id}.artifactRoles[{index}]"),
        )?;
        let role = non_empty(
            entry.get("role").unwrap_or(&Value::Null),
            &format!("{id}.artifactRoles[{index}].role"),
        )?;
        if !role_ids.insert(role) {
            return Err(fault(format!(
                "{id}.artifactRoles contains duplicate roles"
            )));
        }
        roles.push(json!({"role": role, "root": exact_root(entry.get("root").unwrap_or(&Value::Null), &format!("{id}.artifactRoles[{index}].root"))?}));
    }
    let destination = value.get("destination").unwrap_or(&Value::Null);
    exact_fields(
        destination,
        &["kind", "locator"],
        &format!("{id}.destination"),
    )?;
    let destination = json!({
        "kind": non_empty(destination.get("kind").unwrap_or(&Value::Null), &format!("{id}.destination.kind"))?,
        "locator": non_empty(destination.get("locator").unwrap_or(&Value::Null), &format!("{id}.destination.locator"))?,
    });
    let channel_policy = value.get("channelPolicy").unwrap_or(&Value::Null);
    exact_fields(
        channel_policy,
        &["channel", "tagPattern", "authorityMove"],
        &format!("{id}.channelPolicy"),
    )?;
    let channel = channel_policy
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !["alpha", "release", "stable"].contains(&channel)
        || subject.get("channel").and_then(Value::as_str) != Some(channel)
    {
        return Err(fault(format!("{id} channel does not match subject")));
    }
    let tag_pattern = non_empty(
        channel_policy.get("tagPattern").unwrap_or(&Value::Null),
        &format!("{id}.channelPolicy.tagPattern"),
    )?;
    let tag_expression = Regex::new(tag_pattern).map_err(|_| {
        fault(format!(
            "{id}.channelPolicy.tagPattern is not a valid expression"
        ))
    })?;
    if !tag_expression.is_match(
        subject
            .get("tag")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        return Err(fault(format!(
            "{id}.channelPolicy.tagPattern does not match subject.tag"
        )));
    }
    let authority_move = channel_policy
        .get("authorityMove")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !["none", "signed-cas", "verified-ref"].contains(&authority_move) {
        return Err(fault(format!(
            "{id}.channelPolicy.authorityMove is unsupported"
        )));
    }
    let activation = value.get("activationPolicy").unwrap_or(&Value::Null);
    exact_fields(
        activation,
        &["mode", "environment"],
        &format!("{id}.activationPolicy"),
    )?;
    if !["none", "receipt-set", "receipt-only"].contains(
        &activation
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) || !["none", "shadow", "production"].contains(
        &activation
            .get("environment")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        return Err(fault(format!("{id}.activationPolicy is unsupported")));
    }
    let predicates = value
        .get("readbackPredicates")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| fault(format!("{id} must declare at least one readback predicate")))?;
    let mut normalized_predicates = Vec::new();
    let mut predicate_ids = BTreeSet::new();
    for (index, entry) in predicates.iter().enumerate() {
        exact_fields(
            entry,
            &["id", "kind", "expected"],
            &format!("{id}.readbackPredicates[{index}]"),
        )?;
        let predicate_id = non_empty(entry.get("id").unwrap_or(&Value::Null), "predicate.id")?;
        if !predicate_ids.insert(predicate_id) {
            return Err(fault(format!(
                "{id}.readbackPredicates contains duplicate ids"
            )));
        }
        normalized_predicates.push(json!({
            "id": predicate_id,
            "kind": non_empty(entry.get("kind").unwrap_or(&Value::Null), "predicate.kind")?,
            "expected": non_empty(entry.get("expected").unwrap_or(&Value::Null), "predicate.expected")?,
        }));
    }
    let identity = value.get("operationIdentity").unwrap_or(&Value::Null);
    exact_fields(
        identity,
        &[
            "transactionRoot",
            "capabilityId",
            "subjectRoot",
            "targetRoot",
            "attemptKey",
        ],
        &format!("{id}.operationIdentity"),
    )?;
    if identity.get("capabilityId").and_then(Value::as_str) != Some(id) {
        return Err(fault(format!(
            "{id}.operationIdentity.capabilityId must match the capability id"
        )));
    }
    let identity = json!({
        "transactionRoot": exact_root(identity.get("transactionRoot").unwrap_or(&Value::Null), &format!("{id}.operationIdentity.transactionRoot"))?,
        "capabilityId": id,
        "subjectRoot": exact_root(identity.get("subjectRoot").unwrap_or(&Value::Null), &format!("{id}.operationIdentity.subjectRoot"))?,
        "targetRoot": exact_root(identity.get("targetRoot").unwrap_or(&Value::Null), &format!("{id}.operationIdentity.targetRoot"))?,
        "attemptKey": non_empty(identity.get("attemptKey").unwrap_or(&Value::Null), &format!("{id}.operationIdentity.attemptKey"))?,
    });
    let idempotency = value.get("idempotency").unwrap_or(&Value::Null);
    exact_fields(
        idempotency,
        &["scope", "duplicate"],
        &format!("{id}.idempotency"),
    )?;
    if !["operation", "subject-target"].contains(
        &idempotency
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) || !["return-observed-receipt", "readback-before-retry"].contains(
        &idempotency
            .get("duplicate")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        return Err(fault(format!("{id}.idempotency is unsupported")));
    }
    let retry = value.get("retry").unwrap_or(&Value::Null);
    exact_fields(
        retry,
        &["class", "localAttempts", "exhausted"],
        &format!("{id}.retry"),
    )?;
    let attempts = retry
        .get("localAttempts")
        .and_then(Value::as_u64)
        .filter(|value| *value <= 3)
        .ok_or_else(|| {
            fault(format!(
                "{id}.retry.localAttempts must be between zero and three"
            ))
        })?;
    let retry_class = retry
        .get("class")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let exhausted = retry
        .get("exhausted")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !["never", "readback", "provider-transient"].contains(&retry_class)
        || !["blocked", "repair-required", "terminal-failure"].contains(&exhausted)
        || (retry_class == "never" && attempts != 0)
    {
        return Err(fault(format!("{id}.retry is unsupported")));
    }
    let evidence = value
        .get("evidenceRequirements")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| fault(format!("{id}.evidenceRequirements must not be empty")))?;
    let evidence = evidence
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            non_empty(entry, &format!("{id}.evidenceRequirements[{index}]"))
                .map(|entry| json!(entry))
        })
        .collect::<ContractResult<Vec<_>>>()?;
    Ok(json!({
        "id": id, "executor": spec.executor, "adapter": spec.adapter, "artifactRoles": roles,
        "destination": destination,
        "channelPolicy": {"channel": channel, "tagPattern": tag_pattern, "authorityMove": authority_move},
        "activationPolicy": activation,
        "readbackPredicates": normalized_predicates,
        "effect": normalize_message(value.get("effect").unwrap_or(&Value::Null), EFFECT_SCHEMA, spec.effect_kind, &format!("{id}.effect"))?,
        "observation": normalize_message(value.get("observation").unwrap_or(&Value::Null), OBSERVATION_SCHEMA, spec.observation_kind, &format!("{id}.observation"))?,
        "receipt": normalize_message(value.get("receipt").unwrap_or(&Value::Null), RECEIPT_SCHEMA, spec.receipt_kind, &format!("{id}.receipt"))?,
        "operationIdentity": identity, "idempotency": idempotency, "retry": retry,
        "evidenceRequirements": evidence,
    }))
}

pub fn release_tail_root(value: &Value) -> ContractResult<String> {
    let mut bytes = canonical_bytes(value)?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    let mut hash = Sha256::new();
    hash.update(bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub fn parse_release_tail_declaration(value: &Value) -> ContractResult<Value> {
    reject_executable_keys(value, "$")?;
    exact_fields(
        value,
        &[
            "contract",
            "schemaVersion",
            "transactionPolicy",
            "subject",
            "capabilities",
        ],
        "declaration",
    )?;
    if value.get("contract").and_then(Value::as_str) != Some(DECLARATION_CONTRACT) {
        return Err(fault(format!("contract must be {DECLARATION_CONTRACT}")));
    }
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(fault("schemaVersion must be 1"));
    }
    if value.get("transactionPolicy").and_then(Value::as_str) != Some(TRANSACTION_POLICY) {
        return Err(fault(format!(
            "transactionPolicy must be {TRANSACTION_POLICY}"
        )));
    }
    let subject = value.get("subject").unwrap_or(&Value::Null);
    exact_fields(
        subject,
        &["repository", "sourceSha", "version", "tag", "channel"],
        "subject",
    )?;
    let source_sha = non_empty(
        subject.get("sourceSha").unwrap_or(&Value::Null),
        "subject.sourceSha",
    )?
    .to_ascii_lowercase();
    if source_sha.len() != 40
        || !source_sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(fault(
            "subject.sourceSha must be an exact 40-character Git SHA",
        ));
    }
    let channel = subject
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !["alpha", "release", "stable"].contains(&channel) {
        return Err(fault("subject.channel is unsupported"));
    }
    let subject = json!({
        "repository": non_empty(subject.get("repository").unwrap_or(&Value::Null), "subject.repository")?,
        "sourceSha": source_sha,
        "version": non_empty(subject.get("version").unwrap_or(&Value::Null), "subject.version")?,
        "tag": non_empty(subject.get("tag").unwrap_or(&Value::Null), "subject.tag")?,
        "channel": channel,
    });
    let entries = value
        .get("capabilities")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| fault("capabilities must not be empty"))?;
    let mut capabilities = entries
        .iter()
        .map(|entry| normalize_capability(entry, &subject))
        .collect::<ContractResult<Vec<_>>>()?;
    capabilities.sort_by_key(|entry| {
        descriptor(entry.get("id").and_then(Value::as_str).unwrap_or_default())
            .and_then(|entry| {
                DESCRIPTORS
                    .iter()
                    .position(|candidate| candidate.id == entry.id)
            })
            .unwrap_or(usize::MAX)
    });
    let ids = capabilities
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    if ids.len() != capabilities.len() {
        return Err(fault("capability ids must be unique"));
    }
    let roots = capabilities
        .iter()
        .filter_map(|entry| {
            entry
                .pointer("/operationIdentity/transactionRoot")
                .and_then(Value::as_str)
        })
        .collect::<BTreeSet<_>>();
    if roots.len() != 1 {
        return Err(fault(
            "all operation identities must bind one transaction root",
        ));
    }
    Ok(
        json!({"contract": DECLARATION_CONTRACT, "schemaVersion": 1, "transactionPolicy": TRANSACTION_POLICY, "subject": subject, "capabilities": capabilities}),
    )
}

pub fn compile_release_tail_declaration(value: &Value) -> ContractResult<Value> {
    let declaration = parse_release_tail_declaration(value)?;
    let capabilities = declaration
        .get("capabilities")
        .and_then(Value::as_array)
        .expect("normalized capabilities");
    let mut effects = Vec::new();
    for capability in capabilities {
        let identity = capability
            .get("operationIdentity")
            .expect("normalized identity");
        let envelope = json!({
            "schema": EFFECT_SCHEMA, "kind": capability.pointer("/effect/kind"),
            "transactionRoot": identity.get("transactionRoot"), "operationId": release_tail_root(identity)?,
            "capabilityId": capability.get("id"), "executor": capability.get("executor"), "adapter": capability.get("adapter"),
            "subjectRoot": identity.get("subjectRoot"), "targetRoot": identity.get("targetRoot"), "attemptKey": identity.get("attemptKey"),
            "subject": declaration.get("subject"), "artifactRoles": capability.get("artifactRoles"), "destination": capability.get("destination"),
            "channelPolicy": capability.get("channelPolicy"), "activationPolicy": capability.get("activationPolicy"),
            "readbackPredicates": capability.get("readbackPredicates"), "idempotency": capability.get("idempotency"),
            "retry": capability.get("retry"), "evidenceRequirements": capability.get("evidenceRequirements"),
        });
        let mut effect = envelope.as_object().cloned().unwrap_or_default();
        effect.insert(
            "effectRoot".to_owned(),
            json!(release_tail_root(&envelope)?),
        );
        effects.push(Value::Object(effect));
    }
    let operation_order = effects
        .iter()
        .filter_map(|entry| entry.get("operationId"))
        .cloned()
        .collect::<Vec<_>>();
    let plan = json!({
        "schema": PLAN_SCHEMA, "transactionPolicy": TRANSACTION_POLICY,
        "transactionRoot": capabilities[0].pointer("/operationIdentity/transactionRoot"),
        "declarationRoot": release_tail_root(&declaration)?, "subject": declaration.get("subject"),
        "operationOrder": operation_order, "effects": effects,
    });
    let mut result = plan.as_object().cloned().unwrap_or_default();
    result.insert("planRoot".to_owned(), json!(release_tail_root(&plan)?));
    Ok(Value::Object(result))
}

fn without(value: &Value, key: &str) -> Value {
    let mut result = value.as_object().cloned().unwrap_or_default();
    result.remove(key);
    Value::Object(result)
}

pub fn validate_release_tail_effect_plan(plan: &Value) -> Value {
    let mut issues = Vec::new();
    if exact_fields(
        plan,
        &[
            "schema",
            "transactionPolicy",
            "transactionRoot",
            "declarationRoot",
            "subject",
            "operationOrder",
            "effects",
            "planRoot",
        ],
        "effect plan",
    )
    .is_err()
    {
        issues.push("effect plan fields are invalid".to_owned());
    }
    if reject_executable_keys(plan, "$").is_err() {
        issues.push("effect plan contains executable data".to_owned());
    }
    if exact_fields(
        plan.get("subject").unwrap_or(&Value::Null),
        SUBJECT_FIELDS,
        "effect plan subject",
    )
    .is_err()
    {
        issues.push("effect plan subject fields are invalid".to_owned());
    }
    if plan.get("schema").and_then(Value::as_str) != Some(PLAN_SCHEMA) {
        issues.push("effect plan schema is invalid".to_owned());
    }
    if plan.get("transactionPolicy").and_then(Value::as_str) != Some(TRANSACTION_POLICY) {
        issues.push("effect plan transactionPolicy is invalid".to_owned());
    }
    for field in ["transactionRoot", "declarationRoot", "planRoot"] {
        if validate_root(
            plan.get(field).and_then(Value::as_str).unwrap_or_default(),
            field,
        )
        .is_err()
        {
            issues.push(format!("{field} is invalid"));
        }
    }
    let effects = plan.get("effects").and_then(Value::as_array);
    if effects.is_none_or(Vec::is_empty) {
        issues.push("effects must be a non-empty array".to_owned());
    }
    let mut ids = Vec::new();
    for effect in effects.into_iter().flatten() {
        let id = effect
            .get("capabilityId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(spec) = descriptor(id) else {
            issues.push(format!("unsupported effect capability: {id}"));
            continue;
        };
        if exact_fields(effect, EFFECT_FIELDS, &format!("effect {id}")).is_err() {
            issues.push(format!("effect {id} fields are invalid"));
        }
        if effect.get("schema").and_then(Value::as_str) != Some(EFFECT_SCHEMA)
            || effect.get("kind").and_then(Value::as_str) != Some(spec.effect_kind)
            || effect.get("executor").and_then(Value::as_str) != Some(spec.executor)
            || effect.get("adapter").and_then(Value::as_str) != Some(spec.adapter)
        {
            issues.push(format!(
                "effect {id} does not match the capability registry"
            ));
        }
        if effect.get("transactionRoot") != plan.get("transactionRoot") {
            issues.push(format!("effect {id} transactionRoot mismatch"));
        }
        if effect.get("subject") != plan.get("subject") {
            issues.push(format!("effect {id} subject mismatch"));
        }
        if ["subjectRoot", "targetRoot"].iter().any(|field| {
            validate_root(
                effect
                    .get(*field)
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                field,
            )
            .is_err()
        }) {
            issues.push(format!("effect {id} has an invalid subject or target root"));
        }
        let identity = json!({
            "transactionRoot": effect.get("transactionRoot"), "capabilityId": effect.get("capabilityId"),
            "subjectRoot": effect.get("subjectRoot"), "targetRoot": effect.get("targetRoot"), "attemptKey": effect.get("attemptKey"),
        });
        if release_tail_root(&identity).ok().as_deref()
            != effect.get("operationId").and_then(Value::as_str)
        {
            issues.push(format!("effect {id} operationId mismatch"));
        }
        if release_tail_root(&without(effect, "effectRoot"))
            .ok()
            .as_deref()
            != effect.get("effectRoot").and_then(Value::as_str)
        {
            issues.push(format!("effect {id} effectRoot mismatch"));
        }
        ids.push(effect.get("operationId").cloned().unwrap_or(Value::Null));
    }
    if ids
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>()
        .len()
        != ids.len()
    {
        issues.push("effect plan operation ids must be unique".to_owned());
    }
    if plan.get("operationOrder").and_then(Value::as_array) != Some(&ids) {
        issues.push("effect plan operationOrder mismatch".to_owned());
    }
    if release_tail_root(&without(plan, "planRoot"))
        .ok()
        .as_deref()
        != plan.get("planRoot").and_then(Value::as_str)
    {
        issues.push("planRoot mismatch".to_owned());
    }
    json!({"valid": issues.is_empty(), "issues": issues})
}

fn refresh(transaction: &mut Value) -> ContractResult<()> {
    let root = release_tail_root(&without(transaction, "stateRoot"))?;
    transaction
        .as_object_mut()
        .expect("transaction object")
        .insert("stateRoot".to_owned(), json!(root));
    Ok(())
}

pub fn create_release_tail_transaction(value: &Value) -> ContractResult<Value> {
    let plan = if value
        .get("schema")
        .and_then(Value::as_str)
        .is_some_and(|schema| schema.ends_with("effect-plan/v1"))
    {
        value.clone()
    } else {
        compile_release_tail_declaration(value)?
    };
    let validation = validate_release_tail_effect_plan(&plan);
    if validation.get("valid") != Some(&Value::Bool(true)) {
        let issues = validation
            .get("issues")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(fault(format!("invalid release-tail effect plan: {issues}")));
    }
    let operations = plan.get("effects").and_then(Value::as_array).expect("validated effects").iter().map(|effect| json!({
        "operationId": effect.get("operationId"), "capabilityId": effect.get("capabilityId"), "effect": effect,
        "status": "pending", "effectAttempts": 0, "readbackAttempts": 0, "observationRoots": [], "receipt": null,
    })).collect::<Vec<_>>();
    let mut transaction = json!({
        "schema": TRANSACTION_SCHEMA, "transactionPolicy": TRANSACTION_POLICY,
        "transactionRoot": plan.get("transactionRoot"), "declarationRoot": plan.get("declarationRoot"), "planRoot": plan.get("planRoot"),
        "subject": plan.get("subject"), "state": "prepared", "operationOrder": plan.get("operationOrder"), "operations": operations,
        "observations": [], "receipts": [], "failure": null,
    });
    refresh(&mut transaction)?;
    Ok(transaction)
}

pub fn validate_release_tail_transaction(transaction: &Value) -> Value {
    let mut issues = Vec::new();
    if transaction.get("schema").and_then(Value::as_str) != Some(TRANSACTION_SCHEMA) {
        issues.push(format!("schema must be {TRANSACTION_SCHEMA}"));
    }
    if !STATES.contains(
        &transaction
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) {
        issues.push("state is invalid".to_owned());
    }
    for field in ["transactionRoot", "declarationRoot", "planRoot"] {
        if validate_root(
            transaction
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default(),
            field,
        )
        .is_err()
        {
            issues.push(format!("{field} is invalid"));
        }
    }
    let operations = transaction.get("operations").and_then(Value::as_array);
    if operations.is_none() {
        issues.push("operations must be an array".to_owned());
    }
    let ids = operations
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("operationId"))
        .cloned()
        .collect::<Vec<_>>();
    if transaction.get("operationOrder").and_then(Value::as_array) != Some(&ids) {
        issues.push("operations must preserve operationOrder".to_owned());
    }
    for operation in operations.into_iter().flatten() {
        let id = operation
            .get("operationId")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>");
        if !["pending", "complete", "failed"].contains(
            &operation
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            issues.push(format!("operation {id} status is invalid"));
        }
        for field in ["effectAttempts", "readbackAttempts"] {
            if operation.get(field).and_then(Value::as_u64).is_none() {
                issues.push(format!("operation {id} {field} is invalid"));
            }
        }
        if !operation
            .get("observationRoots")
            .is_some_and(Value::is_array)
        {
            issues.push(format!("operation {id} observationRoots is invalid"));
        }
    }
    for (field, root_field) in [
        ("observations", "observationRoot"),
        ("receipts", "receiptRoot"),
    ] {
        let values = transaction.get(field).and_then(Value::as_array);
        if values.is_none() {
            issues.push(format!("{field} must be an array"));
        }
        for value in values.into_iter().flatten() {
            if release_tail_root(&without(value, root_field))
                .ok()
                .as_deref()
                != value.get(root_field).and_then(Value::as_str)
            {
                issues.push(format!("{root_field} mismatch"));
            }
        }
    }
    if release_tail_root(&without(transaction, "stateRoot"))
        .ok()
        .as_deref()
        != transaction.get("stateRoot").and_then(Value::as_str)
    {
        issues.push("stateRoot mismatch".to_owned());
    }
    json!({"valid": issues.is_empty(), "issues": issues})
}

fn pending_index(transaction: &Value) -> Option<usize> {
    transaction
        .get("operations")?
        .as_array()?
        .iter()
        .position(|entry| entry.get("status").and_then(Value::as_str) == Some("pending"))
}

fn set_state(transaction: &mut Value, state: &str) -> ContractResult<()> {
    transaction
        .as_object_mut()
        .expect("transaction object")
        .insert("state".to_owned(), json!(state));
    refresh(transaction)
}

fn instruction(
    transaction: Value,
    checkpoints: Vec<Value>,
    cursor: Value,
    action: &str,
    effect: Option<Value>,
    phase: Option<&str>,
) -> Value {
    json!({"transaction": transaction, "checkpoints": checkpoints, "cursor": cursor, "instruction": {"action": action, "effect": effect, "phase": phase}})
}

pub fn start_release_tail_execution(transaction: &Value) -> ContractResult<Value> {
    let validation = validate_release_tail_transaction(transaction);
    if validation.get("valid") != Some(&Value::Bool(true)) {
        return Err(fault("invalid release-tail transaction"));
    }
    let mut current = transaction.clone();
    if TERMINAL_STATES.contains(
        &current
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    ) || pending_index(&current).is_none()
    {
        return Ok(instruction(
            current,
            vec![],
            Value::Null,
            "done",
            None,
            None,
        ));
    }
    let index = pending_index(&current).expect("pending operation");
    let operation = current
        .pointer(&format!("/operations/{index}"))
        .cloned()
        .expect("operation");
    let spec = descriptor(
        operation
            .get("capabilityId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .ok_or_else(|| fault("unknown capability"))?;
    let mut checkpoints = Vec::new();
    set_state(&mut current, spec.transaction_state)?;
    checkpoints.push(current.clone());
    set_state(&mut current, "reading-back")?;
    checkpoints.push(current.clone());
    let attempts = operation
        .pointer("/effect/retry/localAttempts")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let applied = operation
        .get("effectAttempts")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0;
    let cursor = json!({"operationId": operation.get("operationId"), "cycle": 0, "maxCycles": 1 + attempts, "applied": applied, "transientApplyCode": ""});
    Ok(instruction(
        current,
        checkpoints,
        cursor,
        "readback",
        operation.get("effect").cloned(),
        Some(if applied {
            "retry-readback"
        } else {
            "pre-effect-readback"
        }),
    ))
}

fn normalize_observation(effect: &Value, raw: &Value, phase: &str) -> ContractResult<Value> {
    let outcome = raw
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("transient");
    if !["observed", "absent", "transient", "conflict"].contains(&outcome) {
        return Err(fault("adapter observation outcome is unsupported"));
    }
    let subject_root = raw
        .get("subjectRoot")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target_root = raw
        .get("targetRoot")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !subject_root.is_empty() {
        validate_root(subject_root, "observation.subjectRoot")?;
    }
    if !target_root.is_empty() {
        validate_root(target_root, "observation.targetRoot")?;
    }
    let status = if outcome == "observed" {
        if effect.get("subjectRoot").and_then(Value::as_str) == Some(subject_root)
            && effect.get("targetRoot").and_then(Value::as_str) == Some(target_root)
        {
            "matched"
        } else {
            "stale"
        }
    } else {
        outcome
    };
    let mut evidence = raw
        .get("evidenceRoots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    evidence.sort_by_key(Value::to_string);
    evidence.dedup();
    for root in &evidence {
        validate_root(
            root.as_str().unwrap_or_default(),
            "observation.evidenceRoots",
        )?;
    }
    let provider_code = raw
        .get("providerCode")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
        })
        .unwrap_or(status);
    let body = json!({
        "schema": OBSERVATION_SCHEMA, "kind": descriptor(effect.get("capabilityId").and_then(Value::as_str).unwrap_or_default()).map(|entry| entry.observation_kind),
        "transactionRoot": effect.get("transactionRoot"), "operationId": effect.get("operationId"), "capabilityId": effect.get("capabilityId"),
        "phase": phase, "status": status, "subjectRoot": subject_root, "targetRoot": target_root, "providerCode": provider_code, "evidenceRoots": evidence,
    });
    let mut result = body.as_object().cloned().unwrap_or_default();
    result.insert(
        "observationRoot".to_owned(),
        json!(release_tail_root(&body)?),
    );
    Ok(Value::Object(result))
}

fn fail_operation(
    mut transaction: Value,
    index: usize,
    state: &str,
    code: &str,
    observation: Option<&Value>,
) -> ContractResult<Value> {
    let operation_id = transaction
        .pointer(&format!("/operations/{index}/operationId"))
        .cloned()
        .unwrap_or(Value::Null);
    let capability_id = transaction
        .pointer(&format!("/operations/{index}/capabilityId"))
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(value) = transaction.pointer_mut(&format!("/operations/{index}/status")) {
        *value = json!("failed");
    }
    transaction
        .as_object_mut()
        .expect("transaction")
        .insert("state".to_owned(), json!(state));
    transaction.as_object_mut().expect("transaction").insert("failure".to_owned(), json!({"operationId": operation_id, "capabilityId": capability_id, "code": code, "observationRoot": observation.and_then(|value| value.get("observationRoot")).and_then(Value::as_str).unwrap_or_default()}));
    refresh(&mut transaction)?;
    Ok(transaction)
}

fn complete_operation(
    mut transaction: Value,
    index: usize,
    action: &str,
    observation: &Value,
) -> ContractResult<Value> {
    let operation = transaction
        .pointer(&format!("/operations/{index}"))
        .cloned()
        .expect("operation");
    let effect = operation.get("effect").expect("effect");
    let body = json!({
        "schema": RECEIPT_SCHEMA, "kind": descriptor(operation.get("capabilityId").and_then(Value::as_str).unwrap_or_default()).map(|entry| entry.receipt_kind),
        "transactionRoot": effect.get("transactionRoot"), "operationId": effect.get("operationId"), "capabilityId": effect.get("capabilityId"),
        "subjectRoot": effect.get("subjectRoot"), "targetRoot": effect.get("targetRoot"), "effectRoot": effect.get("effectRoot"), "action": action,
        "effectAttempts": operation.get("effectAttempts"), "readbackAttempts": operation.get("readbackAttempts"), "observationRoots": operation.get("observationRoots"),
        "evidenceRoots": observation.get("evidenceRoots"),
    });
    let mut receipt = body.as_object().cloned().unwrap_or_default();
    receipt.insert("receiptRoot".to_owned(), json!(release_tail_root(&body)?));
    if let Some(value) = transaction.pointer_mut(&format!("/operations/{index}/status")) {
        *value = json!("complete");
    }
    if let Some(value) = transaction.pointer_mut(&format!("/operations/{index}/receipt")) {
        *value = Value::Object(receipt);
    }
    let receipts = transaction
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("receipt"))
        .filter(|entry| !entry.is_null())
        .cloned()
        .collect::<Vec<_>>();
    transaction
        .as_object_mut()
        .expect("transaction")
        .insert("receipts".to_owned(), json!(receipts));
    transaction
        .as_object_mut()
        .expect("transaction")
        .insert("failure".to_owned(), Value::Null);
    let state = pending_index(&transaction)
        .and_then(|index| {
            transaction
                .pointer(&format!("/operations/{index}/capabilityId"))
                .and_then(Value::as_str)
        })
        .and_then(descriptor)
        .map(|entry| entry.transaction_state)
        .unwrap_or("complete");
    set_state(&mut transaction, state)?;
    Ok(transaction)
}

fn next_readback(
    mut transaction: Value,
    mut cursor: Value,
    checkpoints: &mut Vec<Value>,
) -> ContractResult<Value> {
    let cycle = cursor.get("cycle").and_then(Value::as_u64).unwrap_or(0) + 1;
    let max = cursor.get("maxCycles").and_then(Value::as_u64).unwrap_or(1);
    if cycle >= max {
        let index =
            pending_index(&transaction).ok_or_else(|| fault("pending operation disappeared"))?;
        let exhausted = transaction
            .pointer(&format!("/operations/{index}/effect/retry/exhausted"))
            .and_then(Value::as_str)
            .unwrap_or("blocked")
            .to_owned();
        let code = cursor
            .get("transientApplyCode")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("local-retry-exhausted")
            .to_owned();
        transaction = fail_operation(transaction, index, &exhausted, &code, None)?;
        checkpoints.push(transaction.clone());
        return Ok(instruction(
            transaction,
            std::mem::take(checkpoints),
            Value::Null,
            "done",
            None,
            None,
        ));
    }
    cursor
        .as_object_mut()
        .expect("cursor")
        .insert("cycle".to_owned(), json!(cycle));
    set_state(&mut transaction, "reading-back")?;
    checkpoints.push(transaction.clone());
    let index =
        pending_index(&transaction).ok_or_else(|| fault("pending operation disappeared"))?;
    let effect = transaction
        .pointer(&format!("/operations/{index}/effect"))
        .cloned();
    let phase = if cursor.get("applied") == Some(&Value::Bool(true)) {
        "retry-readback"
    } else {
        "pre-effect-readback"
    };
    Ok(instruction(
        transaction,
        std::mem::take(checkpoints),
        cursor,
        "readback",
        effect,
        Some(phase),
    ))
}

pub fn advance_release_tail_execution(value: &Value) -> ContractResult<Value> {
    let mut transaction = value
        .get("transaction")
        .cloned()
        .ok_or_else(|| fault("transaction is required"))?;
    let mut cursor = value
        .get("cursor")
        .cloned()
        .ok_or_else(|| fault("cursor is required"))?;
    let signal = value
        .get("signal")
        .ok_or_else(|| fault("signal is required"))?;
    let operation_id = cursor.get("operationId").cloned().unwrap_or(Value::Null);
    let index = transaction
        .get("operations")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .position(|entry| entry.get("operationId") == Some(&operation_id))
        })
        .ok_or_else(|| fault("unknown release-tail operation"))?;
    let effect = transaction
        .pointer(&format!("/operations/{index}/effect"))
        .cloned()
        .expect("effect");
    let mut checkpoints = Vec::new();
    match signal.get("kind").and_then(Value::as_str) {
        Some("apply") => {
            if signal.get("classification").and_then(Value::as_str) == Some("conflict") {
                let code = signal
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("provider-conflict");
                transaction = fail_operation(transaction, index, "terminal-failure", code, None)?;
                checkpoints.push(transaction.clone());
                Ok(instruction(
                    transaction,
                    checkpoints,
                    Value::Null,
                    "done",
                    None,
                    None,
                ))
            } else {
                if let Some(code) = signal
                    .get("code")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    cursor
                        .as_object_mut()
                        .expect("cursor")
                        .insert("transientApplyCode".to_owned(), json!(code));
                }
                cursor
                    .as_object_mut()
                    .expect("cursor")
                    .insert("applied".to_owned(), Value::Bool(true));
                set_state(&mut transaction, "reading-back")?;
                checkpoints.push(transaction.clone());
                Ok(instruction(
                    transaction,
                    checkpoints,
                    cursor,
                    "readback",
                    Some(effect),
                    Some("post-effect-readback"),
                ))
            }
        }
        Some("readback") => {
            let phase = signal
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("pre-effect-readback");
            let raw = signal.get("raw").unwrap_or(&Value::Null);
            let observation = normalize_observation(&effect, raw, phase)?;
            let attempts = transaction
                .pointer(&format!("/operations/{index}/readbackAttempts"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            *transaction
                .pointer_mut(&format!("/operations/{index}/readbackAttempts"))
                .expect("attempts") = json!(attempts);
            transaction
                .pointer_mut(&format!("/operations/{index}/observationRoots"))
                .and_then(Value::as_array_mut)
                .expect("roots")
                .push(
                    observation
                        .get("observationRoot")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            transaction
                .get_mut("observations")
                .and_then(Value::as_array_mut)
                .expect("observations")
                .push(observation.clone());
            refresh(&mut transaction)?;
            checkpoints.push(transaction.clone());
            match observation.get("status").and_then(Value::as_str) {
                Some("matched") => {
                    let action = if cursor.get("applied") == Some(&Value::Bool(true)) {
                        "applied-and-observed"
                    } else {
                        "observed-existing"
                    };
                    transaction = complete_operation(transaction, index, action, &observation)?;
                    checkpoints.push(transaction.clone());
                    let mut started = start_release_tail_execution(&transaction)?;
                    let mut all = checkpoints;
                    all.extend(
                        started
                            .get_mut("checkpoints")
                            .and_then(Value::as_array_mut)
                            .map(std::mem::take)
                            .unwrap_or_default(),
                    );
                    started
                        .as_object_mut()
                        .expect("result")
                        .insert("checkpoints".to_owned(), json!(all));
                    Ok(started)
                }
                Some("conflict") => {
                    transaction = fail_operation(
                        transaction,
                        index,
                        "terminal-failure",
                        "provider-conflict",
                        Some(&observation),
                    )?;
                    checkpoints.push(transaction.clone());
                    Ok(instruction(
                        transaction,
                        checkpoints,
                        Value::Null,
                        "done",
                        None,
                        None,
                    ))
                }
                Some("stale") => {
                    transaction = fail_operation(
                        transaction,
                        index,
                        "repair-required",
                        "stale-readback",
                        Some(&observation),
                    )?;
                    checkpoints.push(transaction.clone());
                    Ok(instruction(
                        transaction,
                        checkpoints,
                        Value::Null,
                        "done",
                        None,
                        None,
                    ))
                }
                Some("transient") => next_readback(transaction, cursor, &mut checkpoints),
                Some("absent") if cursor.get("applied") == Some(&Value::Bool(true)) => {
                    next_readback(transaction, cursor, &mut checkpoints)
                }
                Some("absent") => {
                    let attempts = transaction
                        .pointer(&format!("/operations/{index}/effectAttempts"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 1;
                    *transaction
                        .pointer_mut(&format!("/operations/{index}/effectAttempts"))
                        .expect("attempts") = json!(attempts);
                    refresh(&mut transaction)?;
                    checkpoints.push(transaction.clone());
                    Ok(instruction(
                        transaction,
                        checkpoints,
                        cursor,
                        "apply",
                        Some(effect),
                        None,
                    ))
                }
                _ => Err(fault("unsupported observation status")),
            }
        }
        _ => Err(fault("unsupported release-tail execution signal")),
    }
}
