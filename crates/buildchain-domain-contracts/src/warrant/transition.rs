use super::*;

pub fn fold_delivery_warrant(
    state: &DeliveryWarrantState,
    decision: &DomainDecision,
) -> ContractResult<DeliveryWarrantState> {
    state.validate()?;
    let mut next = state.clone();
    match &decision.mutation {
        Mutation::None => return Ok(next),
        Mutation::Submit(candidate) => next.candidates.push(candidate.clone()),
        Mutation::TouchDuplicate { index, now } => {
            let candidate = &mut next.candidates[*index];
            if candidate.updated_at.is_some() {
                candidate.updated_at = Some(now.clone());
            }
            if let Some(attempts) = &mut candidate.attempts {
                *attempts += 1;
            }
        }
        Mutation::Select { index, warrant } => {
            next.fencing_counter += 1;
            next.candidates[*index].status = CandidateStatus::Selected;
            if next.candidates[*index].updated_at.is_some() {
                next.candidates[*index].updated_at = warrant.issued_at.clone();
            }
            next.active_warrant = Some(warrant.clone());
        }
        Mutation::RecoverAndSelect { index, warrant } => {
            let candidate = &mut next.candidates[*index];
            candidate.status = CandidateStatus::Selected;
            if candidate.updated_at.is_some() {
                candidate.updated_at = warrant.issued_at.clone();
            }
            if let Some(attempts) = &mut candidate.attempts {
                *attempts += 1;
            }
            if let Some(recoveries) = &mut candidate.recoveries {
                *recoveries += 1;
            }
            next.fencing_counter += 1;
            next.generation += 1;
            next.active_warrant = Some(warrant.clone());
        }
        Mutation::Renew {
            index,
            expires_at,
            now,
        } => {
            next.candidates[*index].status = CandidateStatus::Proving;
            if next.candidates[*index].updated_at.is_some() {
                next.candidates[*index].updated_at = Some(now.clone());
            }
            next.active_warrant
                .as_mut()
                .expect("renew mutation requires an active Warrant")
                .expires_at = Some(expires_at.clone());
        }
        Mutation::Recover { index, now } => {
            let candidate = &mut next.candidates[*index];
            candidate.status = CandidateStatus::Queued;
            if candidate.updated_at.is_some() {
                candidate.updated_at = Some(now.clone());
            }
            if let Some(attempts) = &mut candidate.attempts {
                *attempts += 1;
            }
            if let Some(recoveries) = &mut candidate.recoveries {
                *recoveries += 1;
            }
            next.active_warrant = None;
        }
        Mutation::Settle {
            index,
            terminal,
            clear_warrant,
        } => {
            let candidate = &mut next.candidates[*index];
            candidate.status = terminal.outcome;
            if candidate.updated_at.is_some() {
                candidate.updated_at = Some(terminal.closed_at.clone());
            }
            candidate.terminal = Some(terminal.clone());
            if *clear_warrant {
                next.active_warrant = None;
            }
        }
    }
    next.generation += 1;
    next.validate()?;
    Ok(next)
}

pub fn transition_delivery_warrant(
    state: &DeliveryWarrantState,
    event: &EventEnvelope,
    policy: DeliveryWarrantPolicy,
) -> ContractResult<DomainTransition> {
    let prior_state_root = state.root()?;
    let decision = decide_delivery_warrant(state, event, policy)?;
    let successor_state = fold_delivery_warrant(state, &decision)?;
    let successor_root = successor_state.root()?;
    let event_root = content_root(
        "observation",
        &serde_json::to_value(event).map_err(|error| {
            validation_fault(
                "canonicalization-failed",
                "$/event",
                format!("cannot serialize Delivery Warrant event: {error}"),
            )
        })?,
    )?;
    let outcome = if decision.fault.is_some() {
        "rejected"
    } else if decision.is_noop() {
        "noop"
    } else {
        "accepted"
    };
    let receipt_type = decision
        .action
        .as_deref()
        .unwrap_or("delivery-warrant-rejected")
        .to_owned();
    let receipt = ReceiptEnvelope {
        schema: RECEIPT_ENVELOPE_CONTRACT.to_owned(),
        receipt_type,
        recorded_at: event.occurred_at.clone(),
        event_root,
        prior_state_root: Some(prior_state_root.clone()),
        next_state_root: Some(successor_root.clone()),
        outcome: outcome.to_owned(),
        fault: decision.fault.clone(),
    };
    receipt.validate()?;
    let receipt_value = serde_json::to_value(&receipt).map_err(|error| {
        validation_fault(
            "canonicalization-failed",
            "$/receipt",
            format!("cannot serialize Delivery Warrant receipt: {error}"),
        )
    })?;
    let receipt_root = content_root("transition-receipt", &receipt_value)?;
    let mut effects = Vec::new();
    if successor_root != prior_state_root {
        effects.push(DeclarativeEffect {
            sequence: 0,
            effect_type: "persist-successor".to_owned(),
            payload: json!({
                "expectedOldStateRoot": prior_state_root,
                "nextStateRoot": successor_root,
            }),
        });
        if (decision.event_kind == WarrantEventKind::Select
            || decision.event_kind == WarrantEventKind::Lease)
            && let Some(warrant) = &successor_state.active_warrant
        {
            effects.push(DeclarativeEffect {
                sequence: 1,
                effect_type: "request-admission".to_owned(),
                payload: json!({
                    "candidateId": warrant.candidate_id,
                    "fencingToken": warrant.fencing_token,
                }),
            });
        }
    }
    Ok(DomainTransition {
        decision,
        prior_state_root,
        successor_state,
        successor_root,
        effects,
        receipt,
        receipt_root,
    })
}

pub(super) fn add_seconds(clock: &str, seconds: u64) -> ContractResult<String> {
    validate_clock(clock, "$/clock")?;
    let year = clock[0..4].parse::<i64>().unwrap_or_default();
    let month = clock[5..7].parse::<u32>().unwrap_or_default();
    let day = clock[8..10].parse::<u32>().unwrap_or_default();
    let hour = clock[11..13].parse::<u64>().unwrap_or_default();
    let minute = clock[14..16].parse::<u64>().unwrap_or_default();
    let second = clock[17..19].parse::<u64>().unwrap_or_default();
    let millis = &clock[20..23];
    let days = days_from_civil(year, month, day);
    let total = days
        .checked_mul(86_400)
        .and_then(|value| value.checked_add((hour * 3_600 + minute * 60 + second) as i64))
        .and_then(|value| value.checked_add(seconds as i64))
        .ok_or_else(|| validation_fault("invalid-clock", "$/clock", "clock arithmetic overflow"))?;
    let next_days = total.div_euclid(86_400);
    let day_seconds = total.rem_euclid(86_400) as u64;
    let (next_year, next_month, next_day) = civil_from_days(next_days);
    if !(1..=9_999).contains(&next_year) {
        return Err(validation_fault(
            "invalid-clock",
            "$/clock",
            "clock arithmetic left the supported year range",
        ));
    }
    Ok(format!(
        "{next_year:04}-{next_month:02}-{next_day:02}T{:02}:{:02}:{:02}.{millis}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60,
    ))
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u32, day as u32)
}
