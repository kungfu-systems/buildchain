use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    ContractFault, ContractResult, MAX_SAFE_INTEGER, ascii_token, content_root, validate_clock,
    validate_root,
};

pub const STABLE_PUBLICATION_REQUEST_CONTRACT: &str = "buildchain-v4-stable-publication-request/v1";
pub const STABLE_PUBLICATION_PLAN_CONTRACT: &str = "buildchain-v4-stable-publication-plan/v1";
pub const STABLE_PUBLICATION_FENCE_CONTRACT: &str = "buildchain-v4-stable-publication-fence/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StablePublicationCandidate {
    pub generation: u64,
    pub commit: String,
    pub source_root: String,
    pub metadata_root: String,
    pub journal_root: String,
    pub protected_ancestry_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StablePublicationQualification {
    pub mode: String,
    pub authority_generation: u64,
    pub qualified_candidate_root: String,
    pub qualifier_authority_root: String,
    pub seal_root: String,
    pub source_root: String,
    pub metadata_root: String,
    pub journal_root: String,
    pub protected_ancestry_root: String,
    pub provider_confirmation_roots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StablePublicationTarget {
    pub id: String,
    pub kind: String,
    pub desired: String,
    pub provider_confirmation_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StablePublicationRequest {
    pub schema: String,
    pub declared_at: String,
    pub candidate: StablePublicationCandidate,
    pub qualification: StablePublicationQualification,
    pub publisher_authority_root: String,
    pub targets: Vec<StablePublicationTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StablePublicationQualifiedEvidence {
    pub mode: String,
    pub authority_generation: u64,
    pub qualified_candidate_root: String,
    pub qualifier_authority_root: String,
    pub seal_root: String,
    pub source_root: String,
    pub metadata_root: String,
    pub journal_root: String,
    pub protected_ancestry_root: String,
    pub provider_confirmation_roots: Vec<String>,
    pub qualification_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StablePublicationPlanTarget {
    pub id: String,
    pub kind: String,
    pub desired: String,
    pub provider_confirmation_root: String,
    pub target_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StablePublicationPlan {
    pub schema: String,
    pub mode: String,
    pub production_authority: String,
    pub declared_at: String,
    pub candidate: StablePublicationCandidate,
    pub candidate_root: String,
    pub qualification: StablePublicationQualifiedEvidence,
    pub publisher_authority_root: String,
    pub targets: Vec<StablePublicationPlanTarget>,
    pub plan_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StablePublicationFence {
    pub schema: String,
    pub decision: String,
    pub effect_count: u8,
    pub candidate_root: String,
    pub qualification_mode: String,
    pub qualification_root: String,
    pub plan_root: String,
    pub fence_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StablePublicationProjection {
    pub plan: StablePublicationPlan,
    pub fence: StablePublicationFence,
}

fn fault(code: &str, path: &str, message: impl Into<String>) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn value_root<T: Serialize>(domain: &str, value: &T, path: &str) -> ContractResult<String> {
    let value = serde_json::to_value(value)
        .map_err(|error| fault("canonicalization-failed", path, error.to_string()))?;
    content_root(domain, &value)
}

fn validate_generation(value: u64, path: &str) -> ContractResult<()> {
    if value == 0 || value > MAX_SAFE_INTEGER as u64 {
        return Err(fault(
            "invalid-stable-publication-generation",
            path,
            "generation must be a positive safe integer",
        ));
    }
    Ok(())
}

fn normalize_roots(values: &[String], path: &str) -> ContractResult<Vec<String>> {
    if values.is_empty() {
        return Err(fault(
            "stable-publication-provider-confirmation-mismatch",
            path,
            "provider confirmations must be rooted",
        ));
    }
    for (index, root) in values.iter().enumerate() {
        validate_root(root, &format!("{path}/{index}"))?;
    }
    let mut roots = values.to_vec();
    roots.sort();
    if roots.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(fault(
            "stable-publication-provider-confirmation-mismatch",
            path,
            "provider confirmation roots must be unique",
        ));
    }
    Ok(roots)
}

fn validate_candidate(candidate: &StablePublicationCandidate) -> ContractResult<()> {
    validate_generation(candidate.generation, "$/candidate/generation")?;
    if candidate.commit.len() != 40
        || !candidate
            .commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(fault(
            "invalid-stable-publication-commit",
            "$/candidate/commit",
            "candidate commit must be a lowercase 40-byte Git object id",
        ));
    }
    for (root, path) in [
        (&candidate.source_root, "$/candidate/sourceRoot"),
        (&candidate.metadata_root, "$/candidate/metadataRoot"),
        (&candidate.journal_root, "$/candidate/journalRoot"),
        (
            &candidate.protected_ancestry_root,
            "$/candidate/protectedAncestryRoot",
        ),
    ] {
        validate_root(root, path)?;
    }
    Ok(())
}

fn normalize_targets(
    targets: &[StablePublicationTarget],
) -> ContractResult<Vec<StablePublicationPlanTarget>> {
    if targets.is_empty() {
        return Err(fault(
            "invalid-stable-publication-target",
            "$/targets",
            "at least one shadow publication target is required",
        ));
    }
    let allowed = ["stable-ref", "npm-tag", "oci-tag", "github-release"];
    let mut ids = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    let mut normalized = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let path = format!("$/targets/{index}");
        if !ascii_token(&target.id) {
            return Err(fault(
                "invalid-stable-publication-token",
                &format!("{path}/id"),
                "target id must be an ASCII token",
            ));
        }
        if !allowed.contains(&target.kind.as_str())
            || target.desired.is_empty()
            || target.desired.len() > 200
            || !target
                .desired
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(fault(
                "invalid-stable-publication-target",
                &path,
                "publication target is outside the closed contract",
            ));
        }
        validate_root(
            &target.provider_confirmation_root,
            &format!("{path}/providerConfirmationRoot"),
        )?;
        if !ids.insert(target.id.clone()) || !kinds.insert(target.kind.clone()) {
            return Err(fault(
                "conflicting-stable-publication-target",
                "$/targets",
                "publication target ids and kinds must be unique",
            ));
        }
        normalized.push(StablePublicationPlanTarget {
            id: target.id.clone(),
            kind: target.kind.clone(),
            desired: target.desired.clone(),
            provider_confirmation_root: target.provider_confirmation_root.clone(),
            target_root: value_root("stable-publication-target", target, &path)?,
        });
    }
    normalized.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(normalized)
}

fn validate_qualification(
    request: &StablePublicationRequest,
    candidate_root: &str,
    targets: &[StablePublicationPlanTarget],
) -> ContractResult<StablePublicationQualifiedEvidence> {
    let qualification = &request.qualification;
    if !["n-minus-one", "independent-seal"].contains(&qualification.mode.as_str()) {
        return Err(fault(
            "invalid-stable-publication-qualification",
            "$/qualification/mode",
            "qualification mode is unsupported",
        ));
    }
    validate_generation(
        qualification.authority_generation,
        "$/qualification/authorityGeneration",
    )?;
    for (root, path) in [
        (
            &qualification.qualified_candidate_root,
            "$/qualification/qualifiedCandidateRoot",
        ),
        (
            &qualification.qualifier_authority_root,
            "$/qualification/qualifierAuthorityRoot",
        ),
        (&qualification.seal_root, "$/qualification/sealRoot"),
        (&qualification.source_root, "$/qualification/sourceRoot"),
        (&qualification.metadata_root, "$/qualification/metadataRoot"),
        (&qualification.journal_root, "$/qualification/journalRoot"),
        (
            &qualification.protected_ancestry_root,
            "$/qualification/protectedAncestryRoot",
        ),
    ] {
        validate_root(root, path)?;
    }
    if qualification.qualified_candidate_root != candidate_root {
        return Err(fault(
            "stable-publication-candidate-root-mismatch",
            "$/qualification/qualifiedCandidateRoot",
            "qualification must bind the exact candidate root",
        ));
    }
    let candidate = &request.candidate;
    if (qualification.mode == "n-minus-one"
        && qualification.authority_generation.checked_add(1) != Some(candidate.generation))
        || (qualification.mode == "independent-seal"
            && qualification.authority_generation > candidate.generation)
    {
        return Err(fault(
            "stable-publication-self-qualification",
            "$/qualification/authorityGeneration",
            "qualification generation does not satisfy its independent policy",
        ));
    }
    if qualification.qualifier_authority_root == request.publisher_authority_root {
        return Err(fault(
            "stable-publication-authority-mismatch",
            "$/qualification/qualifierAuthorityRoot",
            "qualification and publication authorities must be independent",
        ));
    }
    for (actual, expected, code, path) in [
        (
            &qualification.source_root,
            &candidate.source_root,
            "stable-publication-source-mismatch",
            "$/qualification/sourceRoot",
        ),
        (
            &qualification.metadata_root,
            &candidate.metadata_root,
            "stable-publication-metadata-mismatch",
            "$/qualification/metadataRoot",
        ),
        (
            &qualification.journal_root,
            &candidate.journal_root,
            "stable-publication-journal-mismatch",
            "$/qualification/journalRoot",
        ),
        (
            &qualification.protected_ancestry_root,
            &candidate.protected_ancestry_root,
            "stable-publication-ancestry-mismatch",
            "$/qualification/protectedAncestryRoot",
        ),
    ] {
        if actual != expected {
            return Err(fault(code, path, "qualification coordinate mismatch"));
        }
    }
    let roots = normalize_roots(
        &qualification.provider_confirmation_roots,
        "$/qualification/providerConfirmationRoots",
    )?;
    let mut target_roots = targets
        .iter()
        .map(|target| target.provider_confirmation_root.clone())
        .collect::<Vec<_>>();
    target_roots.sort();
    if roots != target_roots {
        return Err(fault(
            "stable-publication-provider-confirmation-mismatch",
            "$/qualification/providerConfirmationRoots",
            "qualification must bind every target confirmation and no others",
        ));
    }
    let payload = StablePublicationQualification {
        provider_confirmation_roots: roots.clone(),
        ..qualification.clone()
    };
    let qualification_root = value_root(
        "stable-publication-qualification",
        &payload,
        "$/qualification",
    )?;
    Ok(StablePublicationQualifiedEvidence {
        mode: payload.mode,
        authority_generation: payload.authority_generation,
        qualified_candidate_root: payload.qualified_candidate_root,
        qualifier_authority_root: payload.qualifier_authority_root,
        seal_root: payload.seal_root,
        source_root: payload.source_root,
        metadata_root: payload.metadata_root,
        journal_root: payload.journal_root,
        protected_ancestry_root: payload.protected_ancestry_root,
        provider_confirmation_roots: roots,
        qualification_root,
    })
}

pub fn project_stable_publication(
    request: StablePublicationRequest,
) -> ContractResult<StablePublicationProjection> {
    if request.schema != STABLE_PUBLICATION_REQUEST_CONTRACT {
        return Err(fault(
            "unsupported-stable-publication-version",
            "$/schema",
            "stable publication request version is unsupported",
        ));
    }
    validate_clock(&request.declared_at, "$/declaredAt")?;
    validate_root(
        &request.publisher_authority_root,
        "$/publisherAuthorityRoot",
    )?;
    validate_candidate(&request.candidate)?;
    let candidate_root = value_root(
        "stable-publication-candidate",
        &request.candidate,
        "$/candidate",
    )?;
    let targets = normalize_targets(&request.targets)?;
    let qualification = validate_qualification(&request, &candidate_root, &targets)?;
    let mut plan = StablePublicationPlan {
        schema: STABLE_PUBLICATION_PLAN_CONTRACT.to_owned(),
        mode: "production".to_owned(),
        production_authority: "v4".to_owned(),
        declared_at: request.declared_at,
        candidate: request.candidate,
        candidate_root: candidate_root.clone(),
        qualification,
        publisher_authority_root: request.publisher_authority_root,
        targets,
        plan_root: String::new(),
    };
    plan.plan_root = value_root(
        "stable-publication-plan",
        &serde_json::json!({
            "schema": plan.schema,
            "mode": plan.mode,
            "productionAuthority": plan.production_authority,
            "declaredAt": plan.declared_at,
            "candidate": plan.candidate,
            "candidateRoot": plan.candidate_root,
            "qualification": plan.qualification,
            "publisherAuthorityRoot": plan.publisher_authority_root,
            "targets": plan.targets,
        }),
        "$/plan",
    )?;
    let mut fence = StablePublicationFence {
        schema: STABLE_PUBLICATION_FENCE_CONTRACT.to_owned(),
        decision: "allow-publication".to_owned(),
        effect_count: plan.targets.len() as u8,
        candidate_root,
        qualification_mode: plan.qualification.mode.clone(),
        qualification_root: plan.qualification.qualification_root.clone(),
        plan_root: plan.plan_root.clone(),
        fence_root: String::new(),
    };
    fence.fence_root = value_root(
        "stable-publication-fence",
        &serde_json::json!({
            "schema": fence.schema,
            "decision": fence.decision,
            "effectCount": fence.effect_count,
            "candidateRoot": fence.candidate_root,
            "qualificationMode": fence.qualification_mode,
            "qualificationRoot": fence.qualification_root,
            "planRoot": fence.plan_root,
        }),
        "$/fence",
    )?;
    Ok(StablePublicationProjection { plan, fence })
}

pub fn project_stable_publication_bytes(
    bytes: &[u8],
) -> ContractResult<StablePublicationProjection> {
    let request = serde_json::from_slice(bytes).map_err(|error| {
        fault(
            "invalid-stable-publication-shape",
            "$",
            format!("cannot decode stable publication request: {error}"),
        )
    })?;
    project_stable_publication(request)
}
