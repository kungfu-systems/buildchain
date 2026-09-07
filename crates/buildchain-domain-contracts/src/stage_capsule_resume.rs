use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::stage_capsule::{
    RetentionPromise, StageCapsule, StageCapsuleAvailability, StageCapsuleIdentity,
};
use crate::stage_capsule::{STAGE_CAPSULE_REUSE_CONTRACT, StageCapsuleReuseRequest};
use crate::{
    ContractFault, ContractResult, ascii_token, content_root, evaluate_stage_capsule_reuse,
    validate_clock,
};

mod invalidation;
use invalidation::changed_decision;

pub const STAGE_CAPSULE_RESUME_REQUEST_CONTRACT: &str =
    "buildchain-v4-stage-capsule-resume-request/v1";
pub const STAGE_CAPSULE_RESUME_PLAN_CONTRACT: &str = "buildchain-v4-stage-capsule-resume-plan/v1";

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleResumeCandidate {
    pub capsule: StageCapsule,
    pub availability: StageCapsuleAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleResumeNode {
    pub key: String,
    pub dependencies: Vec<String>,
    pub expected_identity: StageCapsuleIdentity,
    pub expected_retention_promise: RetentionPromise,
    pub candidate: Option<StageCapsuleResumeCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleResumeEffect {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub after_stages: Vec<String>,
    pub provider_readback: bool,
    pub mutation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCapsuleResumeRequest {
    pub schema: String,
    pub evaluated_at: String,
    pub nodes: Vec<StageCapsuleResumeNode>,
    pub targets: Vec<String>,
    pub effects: Vec<StageCapsuleResumeEffect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleInvalidationCause {
    pub field: String,
    pub expected_root: String,
    pub observed_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleResumeRead {
    pub kind: String,
    pub name: String,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleResumeDecision {
    pub stage_key: String,
    pub platform: String,
    pub stage: String,
    pub decision: String,
    pub execution: String,
    pub reason_code: String,
    pub capsule_root: Option<String>,
    pub availability_root: Option<String>,
    pub invalidation_causes: Vec<StageCapsuleInvalidationCause>,
    pub required_reads: Vec<StageCapsuleResumeRead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCapsuleResumePlan {
    pub schema: String,
    pub mode: String,
    pub production_authority: String,
    pub evaluated_at: String,
    pub decisions: Vec<StageCapsuleResumeDecision>,
    pub required_restores: Vec<String>,
    pub required_stages: Vec<String>,
    pub required_effects: Vec<StageCapsuleResumeEffect>,
    pub plan_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageCapsuleResumePlanPayload<'a> {
    schema: &'a str,
    mode: &'a str,
    production_authority: &'a str,
    evaluated_at: &'a str,
    decisions: &'a [StageCapsuleResumeDecision],
    required_restores: &'a [String],
    required_stages: &'a [String],
    required_effects: &'a [StageCapsuleResumeEffect],
}

fn ordered_unique_tokens(values: &[String], path: &str) -> ContractResult<()> {
    let mut prior: Option<&str> = None;
    for (index, value) in values.iter().enumerate() {
        if !ascii_token(value) {
            return Err(fault(
                "invalid-stage-capsule-resume-token",
                &format!("{path}/{index}"),
                "resume planner identifiers must be ASCII tokens",
            ));
        }
        if prior.is_some_and(|entry| value.as_str() <= entry) {
            return Err(fault(
                "unordered-stage-capsule-resume-values",
                &format!("{path}/{index}"),
                "resume planner values must be unique and byte-sorted",
            ));
        }
        prior = Some(value);
    }
    Ok(())
}

fn validate_request(request: &StageCapsuleResumeRequest) -> ContractResult<()> {
    if request.schema != STAGE_CAPSULE_RESUME_REQUEST_CONTRACT || request.nodes.is_empty() {
        return Err(fault(
            "unsupported-stage-capsule-resume-version",
            "$/schema",
            "unsupported or empty Stage Capsule resume request",
        ));
    }
    validate_clock(&request.evaluated_at, "$/evaluatedAt")?;
    let mut positions = BTreeMap::new();
    for (index, node) in request.nodes.iter().enumerate() {
        if !ascii_token(&node.key) || positions.insert(node.key.as_str(), index).is_some() {
            return Err(fault(
                "invalid-stage-capsule-resume-node",
                &format!("$/nodes/{index}/key"),
                "resume node keys must be unique ASCII tokens",
            ));
        }
        node.expected_identity.validate()?;
        node.expected_retention_promise.validate()?;
        ordered_unique_tokens(&node.dependencies, &format!("$/nodes/{index}/dependencies"))?;
        for dependency in &node.dependencies {
            if positions
                .get(dependency.as_str())
                .is_none_or(|position| *position >= index)
            {
                return Err(fault(
                    "invalid-stage-capsule-resume-dependency",
                    &format!("$/nodes/{index}/dependencies"),
                    "dependencies must name an earlier node in topological order",
                ));
            }
        }
        if let Some(candidate) = &node.candidate {
            candidate.capsule.validate()?;
            candidate.availability.validate()?;
        }
    }
    ordered_unique_tokens(&request.targets, "$/targets")?;
    if request.targets.is_empty()
        || request
            .targets
            .iter()
            .any(|target| !positions.contains_key(target.as_str()))
    {
        return Err(fault(
            "invalid-stage-capsule-resume-target",
            "$/targets",
            "targets must name at least one declared node",
        ));
    }
    let mut prior_effect: Option<&str> = None;
    for (index, effect) in request.effects.iter().enumerate() {
        if !ascii_token(&effect.id)
            || !ascii_token(&effect.kind)
            || !ascii_token(&effect.provider)
            || prior_effect.is_some_and(|value| effect.id.as_str() <= value)
            || !effect.provider_readback
            || effect.mutation
        {
            return Err(fault(
                "invalid-stage-capsule-resume-effect",
                &format!("$/effects/{index}"),
                "effects must be sorted, readback-required, mutation-disabled declarations",
            ));
        }
        prior_effect = Some(&effect.id);
        ordered_unique_tokens(
            &effect.after_stages,
            &format!("$/effects/{index}/afterStages"),
        )?;
        if effect
            .after_stages
            .iter()
            .any(|stage| !positions.contains_key(stage.as_str()))
        {
            return Err(fault(
                "invalid-stage-capsule-resume-effect",
                &format!("$/effects/{index}/afterStages"),
                "effect dependencies must name declared stages",
            ));
        }
    }
    Ok(())
}

fn decision(
    node: &StageCapsuleResumeNode,
    decision: &str,
    reason_code: &str,
    capsule_root: Option<String>,
    availability_root: Option<String>,
    invalidation_causes: Vec<StageCapsuleInvalidationCause>,
    required_reads: Vec<StageCapsuleResumeRead>,
) -> StageCapsuleResumeDecision {
    StageCapsuleResumeDecision {
        stage_key: node.key.clone(),
        platform: node.expected_identity.platform.clone(),
        stage: node.expected_identity.stage.clone(),
        decision: decision.to_owned(),
        execution: if decision == "reuse" {
            "reuse".to_owned()
        } else {
            "rebuild".to_owned()
        },
        reason_code: reason_code.to_owned(),
        capsule_root,
        availability_root,
        invalidation_causes,
        required_reads,
    }
}

fn candidate_decision(
    node: &StageCapsuleResumeNode,
    evaluated_at: &str,
) -> ContractResult<StageCapsuleResumeDecision> {
    let Some(candidate) = &node.candidate else {
        return Ok(decision(
            node,
            "rebuild",
            "unavailable",
            None,
            None,
            Vec::new(),
            Vec::new(),
        ));
    };
    let availability_root = candidate.availability.root()?;
    if let Some(changed) = changed_decision(node, candidate, &availability_root)? {
        return Ok(changed);
    }
    let reuse = evaluate_stage_capsule_reuse(&StageCapsuleReuseRequest {
        schema: STAGE_CAPSULE_REUSE_CONTRACT.to_owned(),
        capsule: candidate.capsule.clone(),
        availability: candidate.availability.clone(),
        evaluated_at: evaluated_at.to_owned(),
        expected_capsule_root: candidate.capsule.capsule_root.clone(),
        expected_output_manifest_root: node.expected_identity.output_manifest_root.clone(),
        expected_qualification_root: node.expected_identity.qualification_root.clone(),
    })?;
    if reuse.eligible {
        let mut reads = vec![
            StageCapsuleResumeRead {
                kind: "availability".to_owned(),
                name: node.key.clone(),
                root: availability_root.clone(),
            },
            StageCapsuleResumeRead {
                kind: "capsule".to_owned(),
                name: node.key.clone(),
                root: candidate.capsule.capsule_root.clone(),
            },
            StageCapsuleResumeRead {
                kind: "manifest".to_owned(),
                name: node.key.clone(),
                root: node.expected_identity.output_manifest_root.clone(),
            },
            StageCapsuleResumeRead {
                kind: "qualification".to_owned(),
                name: node.key.clone(),
                root: node.expected_identity.qualification_root.clone(),
            },
        ];
        reads.extend(candidate.availability.transports.iter().map(|transport| {
            StageCapsuleResumeRead {
                kind: "transport".to_owned(),
                name: transport.name.clone(),
                root: transport.root.clone(),
            }
        }));
        return Ok(decision(
            node,
            "reuse",
            "eligible",
            Some(candidate.capsule.capsule_root.clone()),
            Some(availability_root),
            Vec::new(),
            reads,
        ));
    }
    let (kind, reason) = match reuse.reason.as_str() {
        "missing" => ("rebuild", "unavailable"),
        "expired" => ("rebuild", "expired"),
        "partial" => ("reject", "partial"),
        "corrupt" => ("reject", "corrupt"),
        "quarantined" => ("reject", "quarantined"),
        "root-mismatch" => ("reject", "root-mismatch"),
        _ => ("reject", "evidence-insufficient"),
    };
    Ok(decision(
        node,
        kind,
        reason,
        Some(candidate.capsule.capsule_root.clone()),
        Some(availability_root),
        Vec::new(),
        Vec::new(),
    ))
}

pub fn plan_stage_capsule_resume(
    request: &StageCapsuleResumeRequest,
) -> ContractResult<StageCapsuleResumePlan> {
    validate_request(request)?;
    let decisions = request
        .nodes
        .iter()
        .map(|node| candidate_decision(node, &request.evaluated_at))
        .collect::<ContractResult<Vec<_>>>()?;
    let positions = request
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.key.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let mut needed = BTreeSet::new();
    fn mark(
        index: usize,
        request: &StageCapsuleResumeRequest,
        decisions: &[StageCapsuleResumeDecision],
        positions: &BTreeMap<&str, usize>,
        needed: &mut BTreeSet<usize>,
    ) {
        if !needed.insert(index) || decisions[index].execution == "reuse" {
            return;
        }
        for dependency in &request.nodes[index].dependencies {
            mark(
                positions[dependency.as_str()],
                request,
                decisions,
                positions,
                needed,
            );
        }
    }
    for target in &request.targets {
        mark(
            positions[target.as_str()],
            request,
            &decisions,
            &positions,
            &mut needed,
        );
    }
    let required_restores = request
        .nodes
        .iter()
        .enumerate()
        .filter(|(index, _)| needed.contains(index) && decisions[*index].execution == "reuse")
        .map(|(_, node)| node.key.clone())
        .collect::<Vec<_>>();
    let required_stages = request
        .nodes
        .iter()
        .enumerate()
        .filter(|(index, _)| needed.contains(index) && decisions[*index].execution == "rebuild")
        .map(|(_, node)| node.key.clone())
        .collect::<Vec<_>>();
    let mut plan = StageCapsuleResumePlan {
        schema: STAGE_CAPSULE_RESUME_PLAN_CONTRACT.to_owned(),
        mode: "shadow-only".to_owned(),
        production_authority: "v3".to_owned(),
        evaluated_at: request.evaluated_at.clone(),
        decisions,
        required_restores,
        required_stages,
        required_effects: request.effects.clone(),
        plan_root: String::new(),
    };
    let payload = StageCapsuleResumePlanPayload {
        schema: &plan.schema,
        mode: &plan.mode,
        production_authority: &plan.production_authority,
        evaluated_at: &plan.evaluated_at,
        decisions: &plan.decisions,
        required_restores: &plan.required_restores,
        required_stages: &plan.required_stages,
        required_effects: &plan.required_effects,
    };
    let value = serde_json::to_value(payload)
        .map_err(|error| fault("canonicalization-failed", "$/resumePlan", error.to_string()))?;
    plan.plan_root = content_root("stage-capsule-resume-plan", &value)?;
    Ok(plan)
}

pub fn plan_stage_capsule_resume_bytes(bytes: &[u8]) -> ContractResult<StageCapsuleResumePlan> {
    let request: StageCapsuleResumeRequest = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "invalid-stage-capsule-resume-request",
            "$",
            error.to_string(),
        )
    })?;
    plan_stage_capsule_resume(&request)
}
