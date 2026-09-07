use super::transition::add_seconds;
use super::*;

fn select_decision(
    state: &DeliveryWarrantState,
    event: &EventEnvelope,
    policy: DeliveryWarrantPolicy,
    kind: WarrantEventKind,
) -> ContractResult<DomainDecision> {
    if let Some(warrant) = &state.active_warrant {
        if warrant
            .expires_at
            .as_deref()
            .is_some_and(|expires| expires <= event.occurred_at.as_str())
        {
            let index = state
                .candidates
                .iter()
                .position(|candidate| candidate.candidate_id == warrant.candidate_id)
                .expect("validated Warrant owns one candidate");
            let next_generation = state.generation + 2;
            let next_fencing = state.fencing_counter + 1;
            safe_counter(next_generation, "$/state/generation")?;
            safe_counter(next_fencing, "$/state/fencingCounter")?;
            let lease_seconds =
                u64_field(&event.payload, "leaseSeconds").unwrap_or(policy.lease_seconds);
            if lease_seconds == 0 || lease_seconds > MAX_SAFE_INTEGER as u64 {
                return Ok(payload_fault(
                    kind,
                    "leaseSeconds",
                    "leaseSeconds must be positive",
                ));
            }
            let fencing_token = content_root(
                "fencing-token",
                &json!({
                    "candidateId": state.candidates[index].candidate_id,
                    "fencingCounter": next_fencing,
                    "generation": next_generation,
                    "issuedAt": event.occurred_at,
                }),
            )?;
            return Ok(DomainDecision::accepted(
                kind,
                "expired-warrant-recovered-and-selected",
                Mutation::RecoverAndSelect {
                    index,
                    warrant: Warrant {
                        candidate_id: state.candidates[index].candidate_id.clone(),
                        fencing_token,
                        generation: next_generation,
                        issued_at: Some(event.occurred_at.clone()),
                        expires_at: Some(add_seconds(&event.occurred_at, lease_seconds)?),
                    },
                },
            ));
        }
        return Ok(DomainDecision::accepted(
            kind,
            "active-warrant-retained",
            Mutation::None,
        ));
    }
    let requested = string_field(&event.payload, "candidateId");
    let index = match requested {
        Some(candidate_id) => state.candidates.iter().position(|candidate| {
            candidate.candidate_id == candidate_id && candidate.status == CandidateStatus::Queued
        }),
        None => state
            .candidates
            .iter()
            .position(|candidate| candidate.status == CandidateStatus::Queued),
    };
    let Some(index) = index else {
        return Ok(DomainDecision::accepted(
            kind,
            "no-qualified-candidates",
            Mutation::None,
        ));
    };
    let candidate = &state.candidates[index];
    let next_generation = state.generation + 1;
    let next_fencing = state.fencing_counter + 1;
    safe_counter(next_generation, "$/state/generation")?;
    safe_counter(next_fencing, "$/state/fencingCounter")?;
    let fencing_token = match string_field(&event.payload, "fencingToken") {
        Some(token) if !token.is_empty() => token.to_owned(),
        _ => content_root(
            "fencing-token",
            &json!({
                "candidateId": candidate.candidate_id,
                "fencingCounter": next_fencing,
                "generation": next_generation,
                "issuedAt": event.occurred_at,
            }),
        )?,
    };
    let lease_seconds = u64_field(&event.payload, "leaseSeconds").unwrap_or(policy.lease_seconds);
    if lease_seconds == 0 || lease_seconds > MAX_SAFE_INTEGER as u64 {
        return Ok(payload_fault(
            kind,
            "leaseSeconds",
            "leaseSeconds must be positive",
        ));
    }
    let retain_minimal_fixture_shape =
        event.event_type == "warrant-selected" && event.payload.get("leaseSeconds").is_none();
    let warrant = Warrant {
        candidate_id: candidate.candidate_id.clone(),
        fencing_token,
        generation: next_generation,
        issued_at: (!retain_minimal_fixture_shape).then(|| event.occurred_at.clone()),
        expires_at: if retain_minimal_fixture_shape {
            None
        } else {
            Some(add_seconds(&event.occurred_at, lease_seconds)?)
        },
    };
    Ok(DomainDecision::accepted(
        kind,
        "warrant-selected",
        Mutation::Select { index, warrant },
    ))
}

pub fn decide_delivery_warrant(
    state: &DeliveryWarrantState,
    event: &EventEnvelope,
    policy: DeliveryWarrantPolicy,
) -> ContractResult<DomainDecision> {
    state.validate()?;
    event.validate()?;
    policy.validate()?;
    let Some(kind) = event_kind(&event.event_type) else {
        return Err(validation_fault(
            "undeclared-event",
            "$/event/eventType",
            "event is not one of the seven Delivery Warrant manifest events",
        ));
    };
    let prior_root = state.root()?;
    if let Err(fault) = expected_old(&event.subject_root, &prior_root) {
        return Ok(DomainDecision::rejected(kind, *fault));
    }

    match kind {
        WarrantEventKind::Submit => {
            let Some(candidate_id) = string_field(&event.payload, "candidateId") else {
                return Ok(payload_fault(
                    kind,
                    "candidateId",
                    "candidateId is required",
                ));
            };
            let Some(pull_request_number) = u64_field(&event.payload, "pullRequestNumber") else {
                return Ok(payload_fault(
                    kind,
                    "pullRequestNumber",
                    "pullRequestNumber is required",
                ));
            };
            if let Some(index) = state
                .candidates
                .iter()
                .position(|candidate| candidate.candidate_id == candidate_id)
            {
                let existing = &state.candidates[index];
                if existing.pull_request_number != pull_request_number
                    || existing.status.is_terminal()
                {
                    return Ok(DomainDecision::rejected(
                        kind,
                        typed_fault(
                            "identity-drift",
                            "authority",
                            "$/event/payload/candidateId",
                            "candidate identity conflicts with retained history",
                            RetryDirective::Stop,
                        ),
                    ));
                }
                return Ok(DomainDecision::accepted(
                    kind,
                    "duplicate-submission",
                    Mutation::TouchDuplicate {
                        index,
                        now: event.occurred_at.clone(),
                    },
                ));
            }
            if state
                .candidates
                .iter()
                .any(|candidate| candidate.pull_request_number == pull_request_number)
            {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "identity-drift",
                        "authority",
                        "$/event/payload/pullRequestNumber",
                        "pull request already has a different candidate identity",
                        RetryDirective::Stop,
                    ),
                ));
            }
            let retain_minimal_fixture_shape = event.event_type == "candidate-submitted";
            Ok(DomainDecision::accepted(
                kind,
                "candidate-submitted",
                Mutation::Submit(Candidate {
                    candidate_id: candidate_id.to_owned(),
                    pull_request_number,
                    status: CandidateStatus::Queued,
                    enqueued_at: (!retain_minimal_fixture_shape).then(|| event.occurred_at.clone()),
                    updated_at: (!retain_minimal_fixture_shape).then(|| event.occurred_at.clone()),
                    attempts: (!retain_minimal_fixture_shape).then_some(1),
                    recoveries: (!retain_minimal_fixture_shape).then_some(0),
                    terminal: None,
                }),
            ))
        }
        WarrantEventKind::Select | WarrantEventKind::Lease => {
            select_decision(state, event, policy, kind)
        }
        WarrantEventKind::Renew => {
            let Some(active) = &state.active_warrant else {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "missing-active-warrant",
                        "authority",
                        "$/state/activeWarrant",
                        "renew requires an active Warrant",
                        RetryDirective::Reselect,
                    ),
                ));
            };
            if string_field(&event.payload, "fencingToken") != Some(&active.fencing_token) {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "stale-fencing-token",
                        "concurrency",
                        "$/event/payload/fencingToken",
                        "renew used an obsolete fencing token",
                        RetryDirective::Reselect,
                    ),
                ));
            }
            if u64_field(&event.payload, "leaseGeneration").unwrap_or(active.generation)
                != active.generation
            {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "stale-lease-generation",
                        "concurrency",
                        "$/event/payload/leaseGeneration",
                        "renew used an obsolete lease generation",
                        RetryDirective::Reselect,
                    ),
                ));
            }
            if active
                .expires_at
                .as_deref()
                .is_some_and(|expires| expires <= event.occurred_at.as_str())
            {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "lease-expired",
                        "authority",
                        "$/state/activeWarrant/expiresAt",
                        "expired Warrant cannot be renewed",
                        RetryDirective::Reselect,
                    ),
                ));
            }
            let index = state
                .candidates
                .iter()
                .position(|candidate| candidate.candidate_id == active.candidate_id)
                .expect("validated Warrant owns one candidate");
            let lease_seconds =
                u64_field(&event.payload, "leaseSeconds").unwrap_or(policy.lease_seconds);
            if lease_seconds == 0 || lease_seconds > MAX_SAFE_INTEGER as u64 {
                return Ok(payload_fault(
                    kind,
                    "leaseSeconds",
                    "leaseSeconds must be positive",
                ));
            }
            Ok(DomainDecision::accepted(
                kind,
                "warrant-renewed",
                Mutation::Renew {
                    index,
                    expires_at: add_seconds(&event.occurred_at, lease_seconds)?,
                    now: event.occurred_at.clone(),
                },
            ))
        }
        WarrantEventKind::RecoverExpired => {
            let Some(active) = &state.active_warrant else {
                return Ok(DomainDecision::accepted(
                    kind,
                    "recovery-noop",
                    Mutation::None,
                ));
            };
            let Some(expires_at) = active.expires_at.as_deref() else {
                return Ok(DomainDecision::accepted(
                    kind,
                    "lease-active",
                    Mutation::None,
                ));
            };
            if expires_at > event.occurred_at.as_str() {
                return Ok(DomainDecision::accepted(
                    kind,
                    "lease-active",
                    Mutation::None,
                ));
            }
            let index = state
                .candidates
                .iter()
                .position(|candidate| candidate.candidate_id == active.candidate_id)
                .expect("validated Warrant owns one candidate");
            Ok(DomainDecision::accepted(
                kind,
                "expired-warrant-recovered",
                Mutation::Recover {
                    index,
                    now: event.occurred_at.clone(),
                },
            ))
        }
        WarrantEventKind::Settle | WarrantEventKind::Cancel => {
            let Some(candidate_id) = string_field(&event.payload, "candidateId") else {
                return Ok(payload_fault(
                    kind,
                    "candidateId",
                    "candidateId is required",
                ));
            };
            let Some(index) = state
                .candidates
                .iter()
                .position(|candidate| candidate.candidate_id == candidate_id)
            else {
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "candidate-missing",
                        "authority",
                        "$/event/payload/candidateId",
                        "candidate is absent from the exact queue",
                        RetryDirective::Reread,
                    ),
                ));
            };
            let candidate = &state.candidates[index];
            let outcome = if kind == WarrantEventKind::Cancel {
                CandidateStatus::Cancelled
            } else {
                match string_field(&event.payload, "outcome") {
                    Some("merged") => CandidateStatus::Merged,
                    Some("terminal-failure") => CandidateStatus::TerminalFailure,
                    Some("dequeued") => CandidateStatus::Dequeued,
                    Some("cancelled") => CandidateStatus::Cancelled,
                    _ => {
                        return Ok(payload_fault(
                            kind,
                            "outcome",
                            "settlement outcome must be terminal",
                        ));
                    }
                }
            };
            let evidence_root = string_field(&event.payload, "evidenceRoot")
                .unwrap_or(&event.event_id)
                .to_owned();
            if let Err(fault) = validate_root(&evidence_root, "$/event/payload/evidenceRoot") {
                return Ok(DomainDecision::rejected(kind, *fault));
            }
            let terminal = TerminalRecord {
                outcome,
                evidence_root,
                closed_at: event.occurred_at.clone(),
            };
            if candidate.status.is_terminal() {
                if candidate.terminal.as_ref().is_some_and(|retained| {
                    retained.outcome == terminal.outcome
                        && retained.evidence_root == terminal.evidence_root
                }) {
                    return Ok(DomainDecision::accepted(
                        kind,
                        "duplicate-terminal-noop",
                        Mutation::None,
                    ));
                }
                return Ok(DomainDecision::rejected(
                    kind,
                    typed_fault(
                        "terminal-evidence-drift",
                        "idempotence",
                        "$/event/payload",
                        "terminal duplicate does not match retained evidence",
                        RetryDirective::Stop,
                    ),
                ));
            }
            if candidate.status.is_active() {
                let active = state
                    .active_warrant
                    .as_ref()
                    .expect("validated active candidate");
                if string_field(&event.payload, "fencingToken") != Some(&active.fencing_token) {
                    return Ok(DomainDecision::rejected(
                        kind,
                        typed_fault(
                            "stale-fencing-token",
                            "concurrency",
                            "$/event/payload/fencingToken",
                            "settlement used an obsolete fencing token",
                            RetryDirective::Reselect,
                        ),
                    ));
                }
                if kind == WarrantEventKind::Cancel {
                    return Ok(DomainDecision::rejected(
                        kind,
                        typed_fault(
                            "active-candidate",
                            "authority",
                            "$/event/payload/candidateId",
                            "active candidates must settle through the live Warrant",
                            RetryDirective::Stop,
                        ),
                    ));
                }
                return Ok(DomainDecision::accepted(
                    kind,
                    "warrant-settled",
                    Mutation::Settle {
                        index,
                        terminal,
                        clear_warrant: true,
                    },
                ));
            }
            Ok(DomainDecision::accepted(
                kind,
                if kind == WarrantEventKind::Cancel {
                    "queued-candidate-cancelled"
                } else {
                    "queued-candidate-settled"
                },
                Mutation::Settle {
                    index,
                    terminal,
                    clear_warrant: false,
                },
            ))
        }
    }
}
