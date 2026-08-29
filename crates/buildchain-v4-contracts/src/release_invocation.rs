use serde::{Deserialize, Serialize};

use crate::{ContractFault, ContractResult, content_root, validate_root};

pub const RELEASE_INVOCATION_CONTRACT: &str = "kungfu-buildchain-v4-release-invocation/v1";
pub const RELEASE_PROVIDER_CONTRACT: &str = "kungfu-buildchain-release-tail-provider/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleasePublisherIdentity {
    repository: String,
    workflow: String,
    workflow_sha: String,
    job: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRuntimeIdentity {
    repository: String,
    commit: String,
    tree: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseCandidateIdentity {
    repository: String,
    commit: String,
    tree: String,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseTargetIdentity {
    channel: String,
    tag: String,
    expected_old_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAuthorityIdentity {
    policy_root: String,
    qualification_root: String,
    warrant_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseProviderIdentity {
    adapter: String,
    contract: String,
    repository: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseParentLineage {
    invocation_root: Option<String>,
    transaction_root: Option<String>,
    receipt_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseInvocation {
    schema: String,
    publisher: ReleasePublisherIdentity,
    runtime: ReleaseRuntimeIdentity,
    candidate: ReleaseCandidateIdentity,
    target: ReleaseTargetIdentity,
    authority: ReleaseAuthorityIdentity,
    provider: ReleaseProviderIdentity,
    parent: ReleaseParentLineage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInvocationRoots {
    publisher_root: String,
    runtime_root: String,
    candidate_root: String,
    target_root: String,
    authority_root: String,
    provider_root: String,
    parent_root: String,
    invocation_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInvocationProjection {
    invocation: ReleaseInvocation,
    roots: ReleaseInvocationRoots,
}

fn validation(code: &str, path: &str, message: &str) -> Box<ContractFault> {
    Box::new(ContractFault::validation(code, path, message))
}

fn git_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn text(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn release_tag(value: &str) -> bool {
    let Some(version) = value.strip_prefix('v') else {
        return false;
    };
    let core = version.split('-').next().unwrap_or("");
    core.split('.').count() == 3
        && core
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

impl ReleaseInvocation {
    fn validate(&self) -> ContractResult<()> {
        if self.schema != RELEASE_INVOCATION_CONTRACT {
            return Err(validation(
                "invalid-release-invocation",
                "$/schema",
                "unsupported invocation schema",
            ));
        }
        if self.publisher.repository != "kungfu-systems/buildchain"
            || self.publisher.workflow != ".github/workflows/.release-candidate-promote.yml"
            || self.publisher.job != "apply"
            || !git_sha(&self.publisher.workflow_sha)
        {
            return Err(validation(
                "invalid-publisher-identity",
                "$/publisher",
                "publisher identity is not the canonical v4 APPLY job",
            ));
        }
        if self.runtime.repository != "kungfu-systems/buildchain"
            || !git_sha(&self.runtime.commit)
            || !git_sha(&self.runtime.tree)
        {
            return Err(validation(
                "invalid-runtime-identity",
                "$/runtime",
                "runtime identity must bind the canonical repository and exact Git objects",
            ));
        }
        if !text(&self.candidate.repository)
            || !text(&self.candidate.version)
            || !git_sha(&self.candidate.commit)
            || !git_sha(&self.candidate.tree)
        {
            return Err(validation(
                "invalid-candidate-identity",
                "$/candidate",
                "candidate identity is not canonical",
            ));
        }
        if !matches!(self.target.channel.as_str(), "alpha" | "stable")
            || !release_tag(&self.target.tag)
            || self
                .target
                .expected_old_sha
                .as_ref()
                .is_some_and(|sha| !git_sha(sha))
        {
            return Err(validation(
                "invalid-release-target",
                "$/target",
                "release channel and exact tag are not canonical",
            ));
        }
        for (name, root) in [
            ("policyRoot", &self.authority.policy_root),
            ("qualificationRoot", &self.authority.qualification_root),
            ("warrantRoot", &self.authority.warrant_root),
        ] {
            validate_root(root, &format!("$/authority/{name}"))?;
        }
        if self.provider.adapter != "built-in-provider-plane"
            || self.provider.contract != RELEASE_PROVIDER_CONTRACT
            || self.provider.repository != self.candidate.repository
        {
            return Err(validation(
                "invalid-release-provider",
                "$/provider",
                "provider identity must bind the built-in Provider Plane and candidate repository",
            ));
        }
        let parent_roots = [
            self.parent.invocation_root.as_ref(),
            self.parent.transaction_root.as_ref(),
            self.parent.receipt_root.as_ref(),
        ];
        let present = parent_roots.iter().filter(|root| root.is_some()).count();
        if present != 0 && present != parent_roots.len() {
            return Err(validation(
                "invalid-release-parent-lineage",
                "$/parent",
                "parent lineage roots must be either all null or all present",
            ));
        }
        for (name, root) in [
            ("invocationRoot", &self.parent.invocation_root),
            ("transactionRoot", &self.parent.transaction_root),
            ("receiptRoot", &self.parent.receipt_root),
        ] {
            if let Some(root) = root {
                validate_root(root, &format!("$/parent/{name}"))?;
            }
        }
        Ok(())
    }
}

pub fn project_release_invocation(
    invocation: ReleaseInvocation,
) -> ContractResult<ReleaseInvocationProjection> {
    invocation.validate()?;
    let publisher_root = content_root(
        "release-invocation-publisher",
        &serde_json::to_value(&invocation.publisher).unwrap(),
    )?;
    let runtime_root = content_root(
        "release-invocation-runtime",
        &serde_json::to_value(&invocation.runtime).unwrap(),
    )?;
    let candidate_root = content_root(
        "release-invocation-candidate",
        &serde_json::to_value(&invocation.candidate).unwrap(),
    )?;
    let target_root = content_root(
        "release-invocation-target",
        &serde_json::to_value(&invocation.target).unwrap(),
    )?;
    let authority_root = content_root(
        "release-invocation-authority",
        &serde_json::to_value(&invocation.authority).unwrap(),
    )?;
    let provider_root = content_root(
        "release-invocation-provider",
        &serde_json::to_value(&invocation.provider).unwrap(),
    )?;
    let parent_root = content_root(
        "release-invocation-parent",
        &serde_json::to_value(&invocation.parent).unwrap(),
    )?;
    let invocation_root = content_root(
        "release-invocation",
        &serde_json::json!({
            "schema": RELEASE_INVOCATION_CONTRACT,
            "publisherRoot": publisher_root,
            "runtimeRoot": runtime_root,
            "candidateRoot": candidate_root,
            "targetRoot": target_root,
            "authorityRoot": authority_root,
            "providerRoot": provider_root,
            "parentRoot": parent_root,
        }),
    )?;
    Ok(ReleaseInvocationProjection {
        invocation,
        roots: ReleaseInvocationRoots {
            publisher_root,
            runtime_root,
            candidate_root,
            target_root,
            authority_root,
            provider_root,
            parent_root,
            invocation_root,
        },
    })
}

pub fn project_release_invocation_bytes(
    bytes: &[u8],
) -> ContractResult<ReleaseInvocationProjection> {
    let invocation = serde_json::from_slice(bytes).map_err(|error| {
        validation(
            "invalid-release-invocation-shape",
            "$",
            &format!("release invocation is not closed: {error}"),
        )
    })?;
    project_release_invocation(invocation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_closed_alpha_and_stable_invocations() {
        let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../architecture/v4-release-invocation-fixtures.json"
        ))
        .unwrap();
        for name in ["alpha", "stable"] {
            let invocation = serde_json::from_value(fixture["invocations"][name].clone()).unwrap();
            assert!(project_release_invocation(invocation).is_ok(), "{name}");
        }
    }
}
