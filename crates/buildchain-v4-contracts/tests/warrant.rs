use buildchain_v4_contracts::*;
use serde_json::{Value, json};

mod tests {
    use super::*;
    use crate::EVENT_ENVELOPE_CONTRACT;

    fn envelope(
        state: &DeliveryWarrantState,
        event_type: &str,
        now: &str,
        payload: Value,
    ) -> EventEnvelope {
        EventEnvelope {
            schema: EVENT_ENVELOPE_CONTRACT.to_owned(),
            event_id: format!("sha256:{}", "1".repeat(64)),
            event_type: event_type.to_owned(),
            occurred_at: now.to_owned(),
            subject_root: state.root().unwrap(),
            payload,
        }
    }

    fn submit(state: &DeliveryWarrantState, now: &str) -> DomainTransition {
        transition_delivery_warrant(
            state,
            &envelope(
                state,
                "submit",
                now,
                json!({"candidateId":"candidate-101","pullRequestNumber":101}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap()
    }

    fn select(state: &DeliveryWarrantState, now: &str, lease_seconds: u64) -> DomainTransition {
        transition_delivery_warrant(
            state,
            &envelope(
                state,
                "select",
                now,
                json!({"candidateId":"candidate-101","leaseSeconds":lease_seconds}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap()
    }

    #[test]
    fn freezes_manifest_surface_and_retained_disagreements() {
        assert_eq!(DELIVERY_WARRANT_EVENTS.len(), 7);
        assert_eq!(DELIVERY_WARRANT_PRIMITIVES.len(), 9);
        assert_eq!(DELIVERY_WARRANT_LEGACY_DISAGREEMENTS.len(), 7);
        let states = serde_json::to_value([
            CandidateStatus::Queued,
            CandidateStatus::Selected,
            CandidateStatus::Proving,
            CandidateStatus::Waiting,
            CandidateStatus::Blocked,
            CandidateStatus::Merged,
            CandidateStatus::TerminalFailure,
            CandidateStatus::Dequeued,
            CandidateStatus::Cancelled,
        ])
        .unwrap();
        assert_eq!(states.as_array().unwrap().len(), 9);
    }

    #[test]
    fn golden_submit_select_is_deterministic_and_declarative() {
        let initial = DeliveryWarrantState::default();
        let submitted = submit(&initial, "2026-08-07T00:00:01.000Z");
        let selected = select(&submitted.successor_state, "2026-08-07T00:00:02.000Z", 60);
        let replayed_submit = submit(&initial, "2026-08-07T00:00:01.000Z");
        assert_eq!(submitted, replayed_submit);
        assert_eq!(submitted.successor_state.generation, 1);
        assert_eq!(selected.successor_state.generation, 2);
        assert_eq!(selected.successor_state.fencing_counter, 1);
        assert_eq!(
            selected
                .effects
                .iter()
                .map(|effect| effect.effect_type.as_str())
                .collect::<Vec<_>>(),
            ["persist-successor", "request-admission"]
        );
    }

    #[test]
    fn duplicate_submit_retains_legacy_root_mutation() {
        let initial = DeliveryWarrantState::default();
        let submitted = submit(&initial, "2026-08-07T00:00:01.000Z");
        let duplicate = submit(&submitted.successor_state, "2026-08-07T00:00:02.000Z");
        assert_eq!(
            duplicate.decision.action.as_deref(),
            Some("duplicate-submission")
        );
        assert_eq!(duplicate.successor_state.generation, 2);
        assert_ne!(duplicate.prior_state_root, duplicate.successor_root);
    }

    #[test]
    fn stale_cas_and_fence_are_typed_no_effect_faults() {
        let initial = DeliveryWarrantState::default();
        let mut stale = envelope(
            &initial,
            "submit",
            "2026-08-07T00:00:01.000Z",
            json!({"candidateId":"candidate-101","pullRequestNumber":101}),
        );
        stale.subject_root = format!("sha256:{}", "f".repeat(64));
        let rejected =
            transition_delivery_warrant(&initial, &stale, DeliveryWarrantPolicy::default())
                .unwrap();
        assert_eq!(
            rejected.decision.fault.as_ref().unwrap().code,
            "stale-expected-old"
        );
        assert!(rejected.effects.is_empty());

        let submitted = submit(&initial, "2026-08-07T00:00:01.000Z");
        let selected = select(&submitted.successor_state, "2026-08-07T00:00:02.000Z", 60);
        let renewed = transition_delivery_warrant(
            &selected.successor_state,
            &envelope(
                &selected.successor_state,
                "renew",
                "2026-08-07T00:00:03.000Z",
                json!({"fencingToken":"obsolete","leaseGeneration":2}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            renewed.decision.fault.as_ref().unwrap().code,
            "stale-fencing-token"
        );
        assert!(renewed.effects.is_empty());
    }

    #[test]
    fn lease_expiry_recovery_reselect_and_old_fence_rejection() {
        let initial = DeliveryWarrantState::default();
        let submitted = submit(&initial, "2026-08-07T00:00:01.000Z");
        let selected = select(&submitted.successor_state, "2026-08-07T00:00:02.000Z", 60);
        let old_fence = selected
            .successor_state
            .active_warrant
            .as_ref()
            .unwrap()
            .fencing_token
            .clone();
        let recovered = transition_delivery_warrant(
            &selected.successor_state,
            &envelope(
                &selected.successor_state,
                "recover-expired",
                "2026-08-07T00:01:02.000Z",
                json!({}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap();
        assert!(recovered.successor_state.active_warrant.is_none());
        let reselected = select(&recovered.successor_state, "2026-08-07T00:01:03.000Z", 60);
        assert_ne!(
            reselected
                .successor_state
                .active_warrant
                .as_ref()
                .unwrap()
                .fencing_token,
            old_fence
        );
    }

    #[test]
    fn cancellation_duplicate_response_loss_and_provider_conflict_stop_safely() {
        let initial = DeliveryWarrantState::default();
        let submitted = submit(&initial, "2026-08-07T00:00:01.000Z");
        let evidence = format!("sha256:{}", "e".repeat(64));
        let cancelled = transition_delivery_warrant(
            &submitted.successor_state,
            &envelope(
                &submitted.successor_state,
                "cancel",
                "2026-08-07T00:00:02.000Z",
                json!({"candidateId":"candidate-101","evidenceRoot":evidence}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            cancelled.successor_state.candidates[0].status,
            CandidateStatus::Cancelled
        );
        let duplicate = transition_delivery_warrant(
            &cancelled.successor_state,
            &envelope(
                &cancelled.successor_state,
                "cancel",
                "2026-08-07T00:00:03.000Z",
                json!({"candidateId":"candidate-101","evidenceRoot":format!("sha256:{}", "e".repeat(64))}),
            ),
            DeliveryWarrantPolicy::default(),
        )
        .unwrap();
        assert!(duplicate.decision.is_noop());
        assert!(duplicate.effects.is_empty());
        assert_eq!(
            reconcile_response_loss(&cancelled.successor_root, &cancelled.successor_root),
            Ok(RetryDirective::Stop)
        );
        let conflict = reconcile_response_loss(
            &cancelled.successor_root,
            &format!("sha256:{}", "0".repeat(64)),
        )
        .unwrap_err();
        assert_eq!(conflict.code, "response-loss");
        assert_eq!(typed_retry(&conflict, 1), RetryDirective::Stop);
        let provider = provider_conflict(&format!("sha256:{}", "a".repeat(64))).unwrap();
        assert_eq!(provider.code, "provider-conflict");
        assert_eq!(provider.retry, "stop");
    }

    #[test]
    fn shared_runner_golden_and_replay_inputs_drive_the_same_domain_boundary() {
        let golden_bytes =
            include_bytes!("../../../contracts/fixtures/v4-delivery-warrant-trace-v1/golden.json");
        let replay_bytes =
            include_bytes!("../../../contracts/fixtures/v4-delivery-warrant-trace-v1/replay.json");
        assert!(crate::run_delivery_warrant_trace_fixture(golden_bytes).is_ok());
        assert!(crate::run_delivery_warrant_trace_fixture(replay_bytes).is_ok());

        let golden: Value = serde_json::from_slice(golden_bytes).unwrap();
        let mut state: DeliveryWarrantState =
            serde_json::from_value(golden["trace"]["initialState"].clone()).unwrap();
        for step in golden["trace"]["steps"].as_array().unwrap() {
            let event: EventEnvelope = serde_json::from_value(step["event"].clone()).unwrap();
            let transition =
                transition_delivery_warrant(&state, &event, DeliveryWarrantPolicy::default())
                    .unwrap();
            let expected: DeliveryWarrantState =
                serde_json::from_value(step["successorState"].clone()).unwrap();
            assert_eq!(transition.successor_state, expected);
            assert_eq!(transition.successor_root, step["successorRoot"]);
            state = transition.successor_state;
        }

        let replay: Value = serde_json::from_slice(replay_bytes).unwrap();
        let replay_state: DeliveryWarrantState =
            serde_json::from_value(replay["trace"]["initialState"].clone()).unwrap();
        let replay_event: EventEnvelope =
            serde_json::from_value(replay["trace"]["steps"][0]["event"].clone()).unwrap();
        let decision = decide_delivery_warrant(
            &replay_state,
            &replay_event,
            DeliveryWarrantPolicy::default(),
        )
        .unwrap();
        assert_eq!(decision.fault.as_ref().unwrap().code, "stale-fencing-token");
        assert_eq!(
            fold_delivery_warrant(&replay_state, &decision).unwrap(),
            replay_state
        );
    }

    #[test]
    fn bounded_property_sequences_preserve_generation_and_fencing_invariants() {
        for count in 1..=32_u64 {
            let mut state = DeliveryWarrantState::default();
            for pull in 1..=count {
                let transition = transition_delivery_warrant(
                    &state,
                    &envelope(
                        &state,
                        "submit",
                        "2026-08-07T00:00:01.000Z",
                        json!({
                            "candidateId": format!("candidate-{pull}"),
                            "pullRequestNumber": pull,
                        }),
                    ),
                    DeliveryWarrantPolicy::default(),
                )
                .unwrap();
                assert_eq!(transition.successor_state.generation, pull);
                assert_eq!(transition.successor_state.fencing_counter, 0);
                state = transition.successor_state;
            }
            state.validate().unwrap();
        }
    }
}
