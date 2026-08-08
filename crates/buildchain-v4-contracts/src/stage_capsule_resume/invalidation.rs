use serde::Serialize;

use super::{
    StageCapsuleInvalidationCause, StageCapsuleResumeCandidate, StageCapsuleResumeDecision,
    StageCapsuleResumeNode, decision,
};
use crate::{ContractResult, content_root, validate_root};

fn value_root(value: impl Serialize) -> ContractResult<String> {
    let value = serde_json::to_value(value).map_err(|error| {
        super::fault(
            "canonicalization-failed",
            "$/resumeObservation",
            error.to_string(),
        )
    })?;
    content_root("stage-capsule-resume-observation", &value)
}

fn root_or_value_root(value: &str) -> ContractResult<String> {
    if validate_root(value, "$/resumeObservation").is_ok() {
        Ok(value.to_owned())
    } else {
        value_root(value)
    }
}

fn cause<T: Serialize>(
    field: &str,
    expected: T,
    observed: T,
) -> ContractResult<StageCapsuleInvalidationCause> {
    Ok(StageCapsuleInvalidationCause {
        field: field.to_owned(),
        expected_root: value_root(expected)?,
        observed_root: value_root(observed)?,
    })
}

fn root_cause(
    field: &str,
    expected: &str,
    observed: &str,
) -> ContractResult<StageCapsuleInvalidationCause> {
    Ok(StageCapsuleInvalidationCause {
        field: field.to_owned(),
        expected_root: root_or_value_root(expected)?,
        observed_root: root_or_value_root(observed)?,
    })
}

type Change = (&'static str, &'static str, StageCapsuleInvalidationCause);

fn change(
    kind: &'static str,
    reason: &'static str,
    cause: StageCapsuleInvalidationCause,
) -> Option<Change> {
    Some((kind, reason, cause))
}

pub(super) fn changed_decision(
    node: &StageCapsuleResumeNode,
    candidate: &StageCapsuleResumeCandidate,
    availability_root: &str,
) -> ContractResult<Option<StageCapsuleResumeDecision>> {
    let want = &node.expected_identity;
    let got = &candidate.capsule.identity;
    let capsule_root = Some(candidate.capsule.capsule_root.clone());
    let availability_root = Some(availability_root.to_owned());
    let changed = if want.platform != got.platform {
        change(
            "reject",
            "cross-platform",
            cause("platform", &want.platform, &got.platform)?,
        )
    } else if want.stage != got.stage {
        change(
            "reject",
            "stage-mismatch",
            cause("stage", &want.stage, &got.stage)?,
        )
    } else if want.source_root != got.source_root {
        change(
            "rebuild",
            "source-changed",
            root_cause("source-root", &want.source_root, &got.source_root)?,
        )
    } else if want.platform_root != got.platform_root {
        change(
            "rebuild",
            "platform-changed",
            root_cause("platform-root", &want.platform_root, &got.platform_root)?,
        )
    } else if want.toolchain_roots != got.toolchain_roots {
        change(
            "rebuild",
            "toolchain-changed",
            cause(
                "toolchain-roots",
                &want.toolchain_roots,
                &got.toolchain_roots,
            )?,
        )
    } else if want.runtime_root != got.runtime_root {
        change(
            "rebuild",
            "runtime-changed",
            root_cause("runtime-root", &want.runtime_root, &got.runtime_root)?,
        )
    } else if want.policy_root != got.policy_root {
        change(
            "rebuild",
            "policy-changed",
            root_cause("policy-root", &want.policy_root, &got.policy_root)?,
        )
    } else if want.declared_inputs != got.declared_inputs {
        change(
            "rebuild",
            "input-changed",
            cause(
                "declared-inputs",
                &want.declared_inputs,
                &got.declared_inputs,
            )?,
        )
    } else if want.transformation_root != got.transformation_root {
        change(
            "rebuild",
            "transformation-changed",
            root_cause(
                "transformation-root",
                &want.transformation_root,
                &got.transformation_root,
            )?,
        )
    } else if want.output_manifest_root != got.output_manifest_root {
        change(
            "rebuild",
            "output-manifest-changed",
            root_cause(
                "output-manifest-root",
                &want.output_manifest_root,
                &got.output_manifest_root,
            )?,
        )
    } else if want.qualification_root != got.qualification_root {
        change(
            "reject",
            "evidence-insufficient",
            root_cause(
                "qualification-root",
                &want.qualification_root,
                &got.qualification_root,
            )?,
        )
    } else if want.observation_roots != got.observation_roots {
        change(
            "reject",
            "evidence-insufficient",
            cause(
                "observation-roots",
                &want.observation_roots,
                &got.observation_roots,
            )?,
        )
    } else if node.expected_retention_promise != candidate.capsule.retention_promise {
        change(
            "rebuild",
            "retention-changed",
            cause(
                "retention-promise",
                &node.expected_retention_promise,
                &candidate.capsule.retention_promise,
            )?,
        )
    } else {
        None
    };
    Ok(changed.map(|(kind, reason, cause)| {
        decision(
            node,
            kind,
            reason,
            capsule_root,
            availability_root,
            vec![cause],
            Vec::new(),
        )
    }))
}
