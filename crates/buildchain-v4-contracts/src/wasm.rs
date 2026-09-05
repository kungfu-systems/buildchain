use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    ContractFault, ProviderOperationEntry, ProviderOperationIdentity, ProviderReadbackCoordinates,
    ProviderReadbackSample, adapt_release_invocation, advance_release_tail_execution,
    canonical_bytes, compile_release_tail_declaration, content_root,
    create_product_publication_declaration, create_product_publication_plan,
    create_release_receipt, create_release_tail_transaction, create_release_transaction,
    fold_provider_operation_journal, fold_provider_readback_samples,
    parse_release_tail_declaration, plan_partial_mutation_recovery_bytes, plan_release_route,
    project_release_activation_bytes, project_release_invocation_bytes,
    project_stable_publication_bytes, release_tail_root, run_provider_operation_journal_fixture,
    select_product_publication_intent, start_release_tail_execution,
    validate_release_tail_effect_plan, validate_release_tail_transaction,
};

const REQUEST_CONTRACT: &str = "kungfu-buildchain-v4-domain-wasm-request/v1";
const RESPONSE_CONTRACT: &str = "kungfu-buildchain-v4-domain-wasm-response/v1";
const ABI_VERSION: u32 = 1;

thread_local! {
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmRequest {
    schema: String,
    operation: String,
    payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmResponse {
    schema: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fault: Option<ContractFault>,
}

fn fault(code: &str, path: &str, message: impl Into<String>) -> ContractFault {
    ContractFault::validation(code, path, message)
}

fn payload_bytes(payload: &Value) -> Result<Vec<u8>, ContractFault> {
    serde_json::to_vec(payload)
        .map_err(|error| fault("invalid-wasm-payload", "$/payload", error.to_string()))
}

fn serialized_value<T: Serialize>(value: T) -> Result<Value, ContractFault> {
    serde_json::to_value(value)
        .map_err(|error| fault("wasm-response-serialization-failed", "$", error.to_string()))
}

fn dispatch(request: WasmRequest) -> Result<Value, ContractFault> {
    if request.schema != REQUEST_CONTRACT {
        return Err(fault(
            "unsupported-wasm-request",
            "$/schema",
            "unsupported Rust/WASM domain request contract",
        ));
    }

    match request.operation.as_str() {
        "abi-info" => Ok(json!({
            "abiVersion": ABI_VERSION,
            "requestContract": REQUEST_CONTRACT,
            "responseContract": RESPONSE_CONTRACT,
        })),
        "canonical-json" => {
            let bytes = canonical_bytes(&request.payload).map_err(|error| *error)?;
            let canonical_utf8 = String::from_utf8(bytes).map_err(|_| {
                fault(
                    "canonicalization-failed",
                    "$/payload",
                    "canonical JSON is not UTF-8",
                )
            })?;
            Ok(json!({ "canonicalUtf8": canonical_utf8 }))
        }
        "content-root" => {
            let domain = request
                .payload
                .get("domain")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    fault(
                        "invalid-wasm-payload",
                        "$/payload/domain",
                        "content-root requires a domain string",
                    )
                })?;
            let value = request.payload.get("value").ok_or_else(|| {
                fault(
                    "invalid-wasm-payload",
                    "$/payload/value",
                    "content-root requires a value",
                )
            })?;
            Ok(json!({ "root": content_root(domain, value).map_err(|error| *error)? }))
        }
        "release-invocation" => serialized_value(
            project_release_invocation_bytes(&payload_bytes(&request.payload)?)
                .map_err(|error| *error)?,
        ),
        "release-invocation-adapter" => {
            adapt_release_invocation(&request.payload).map_err(|error| *error)
        }
        "release-route" => plan_release_route(&request.payload).map_err(|error| *error),
        "release-transaction" => {
            create_release_transaction(&request.payload).map_err(|error| *error)
        }
        "release-receipt" => create_release_receipt(&request.payload).map_err(|error| *error),
        "product-publication-intent" => {
            select_product_publication_intent(&request.payload).map_err(|error| *error)
        }
        "product-publication-plan" => {
            create_product_publication_plan(&request.payload).map_err(|error| *error)
        }
        "product-publication-declaration" => {
            create_product_publication_declaration(&request.payload).map_err(|error| *error)
        }
        "release-tail-root" => Ok(json!({
            "root": release_tail_root(&request.payload).map_err(|error| *error)?
        })),
        "release-tail-parse" => {
            parse_release_tail_declaration(&request.payload).map_err(|error| *error)
        }
        "release-tail-compile" => {
            compile_release_tail_declaration(&request.payload).map_err(|error| *error)
        }
        "release-tail-create" => {
            create_release_tail_transaction(&request.payload).map_err(|error| *error)
        }
        "release-tail-validate-plan" => Ok(validate_release_tail_effect_plan(&request.payload)),
        "release-tail-validate-transaction" => {
            Ok(validate_release_tail_transaction(&request.payload))
        }
        "release-tail-execution-start" => {
            start_release_tail_execution(&request.payload).map_err(|error| *error)
        }
        "release-tail-execution-advance" => {
            advance_release_tail_execution(&request.payload).map_err(|error| *error)
        }
        "provider-operation-identity-validate" => {
            let identity: ProviderOperationIdentity =
                serde_json::from_value(request.payload.clone()).map_err(|error| {
                    fault(
                        "invalid-provider-operation-shape",
                        "$/operation",
                        error.to_string(),
                    )
                })?;
            identity.validate().map_err(|error| *error)?;
            Ok(request.payload)
        }
        "provider-operation-identity-root" => {
            let identity: ProviderOperationIdentity = serde_json::from_value(request.payload)
                .map_err(|error| {
                    fault(
                        "invalid-provider-operation-shape",
                        "$/operation",
                        error.to_string(),
                    )
                })?;
            Ok(json!({"root": identity.root().map_err(|error| *error)?}))
        }
        "provider-operation-entry-root" => {
            let entry: ProviderOperationEntry =
                serde_json::from_value(request.payload).map_err(|error| {
                    fault(
                        "invalid-provider-operation-shape",
                        "$/entry",
                        error.to_string(),
                    )
                })?;
            Ok(json!({"root": entry.calculated_root().map_err(|error| *error)?}))
        }
        "provider-operation-entry-validate" => {
            let entry: ProviderOperationEntry = serde_json::from_value(request.payload.clone())
                .map_err(|error| {
                    fault(
                        "invalid-provider-operation-shape",
                        "$/entry",
                        error.to_string(),
                    )
                })?;
            entry.validate().map_err(|error| *error)?;
            Ok(request.payload)
        }
        "provider-operation-journal" => {
            let entries: Vec<ProviderOperationEntry> =
                serde_json::from_value(request.payload.clone()).map_err(|error| {
                    fault(
                        "invalid-provider-operation-shape",
                        "$/entries",
                        error.to_string(),
                    )
                })?;
            let state = fold_provider_operation_journal(&entries).map_err(|error| *error)?;
            let state_value = serde_json::to_value(&state).map_err(|error| {
                fault("wasm-response-serialization-failed", "$", error.to_string())
            })?;
            Ok(json!({
                "state": state_value,
                "journalRoot": content_root("provider-operation-journal", &request.payload).map_err(|error| *error)?,
                "stateRoot": state.root().map_err(|error| *error)?,
            }))
        }
        "provider-operation-fixtures" => serialized_value(
            run_provider_operation_journal_fixture(&payload_bytes(&request.payload)?)
                .map_err(|error| *error)?,
        ),
        "provider-readback-fold" => {
            let samples: Vec<ProviderReadbackSample> = serde_json::from_value(
                request
                    .payload
                    .get("samples")
                    .cloned()
                    .unwrap_or(Value::Null),
            )
            .map_err(|error| {
                fault(
                    "malformed-provider-readback",
                    "$/samples",
                    error.to_string(),
                )
            })?;
            let coordinates: ProviderReadbackCoordinates = serde_json::from_value(
                request
                    .payload
                    .get("coordinates")
                    .cloned()
                    .unwrap_or(Value::Null),
            )
            .map_err(|error| {
                fault(
                    "malformed-provider-readback",
                    "$/coordinates",
                    error.to_string(),
                )
            })?;
            serialized_value(
                fold_provider_readback_samples(&samples, &coordinates).map_err(|error| *error)?,
            )
        }
        "release-activation" => serialized_value(
            project_release_activation_bytes(&payload_bytes(&request.payload)?)
                .map_err(|error| *error)?,
        ),
        "stable-publication" => serialized_value(
            project_stable_publication_bytes(&payload_bytes(&request.payload)?)
                .map_err(|error| *error)?,
        ),
        "partial-mutation-recovery" => serialized_value(
            plan_partial_mutation_recovery_bytes(&payload_bytes(&request.payload)?)
                .map_err(|error| *error)?,
        ),
        _ => dispatch_verification(request),
    }
}

fn dispatch_verification(request: WasmRequest) -> Result<Value, ContractFault> {
    match request.operation.as_str() {
        "source-version-projection" => {
            crate::validate_source_version_projection(&request.payload).map_err(|error| *error)
        }
        "source-verification-seal" => {
            crate::seal_source_verification(&request.payload).map_err(|error| *error)
        }
        "source-verification-plan" => {
            crate::plan_source_verification(&request.payload).map_err(|error| *error)
        }
        _ => Err(fault(
            "unsupported-wasm-operation",
            "$/operation",
            format!(
                "unsupported Rust/WASM domain operation '{}'",
                request.operation
            ),
        )),
    }
}

fn response_bytes(input: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<WasmRequest>(input)
        .map_err(|error| fault("invalid-wasm-request", "$", error.to_string()))
        .and_then(dispatch);
    let response = match result {
        Ok(value) => WasmResponse {
            schema: RESPONSE_CONTRACT,
            ok: true,
            value: Some(value),
            fault: None,
        },
        Err(fault) => WasmResponse {
            schema: RESPONSE_CONTRACT,
            ok: false,
            value: None,
            fault: Some(fault),
        },
    };
    serde_json::to_vec(&response).unwrap_or_else(|_| {
        br#"{"schema":"kungfu-buildchain-v4-domain-wasm-response/v1","ok":false,"fault":{"schema":"buildchain-v4-contract-fault/v1","code":"wasm-response-serialization-failed","class":"validation","path":"$","message":"Rust/WASM response serialization failed","retry":"stop"}}"#.to_vec()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn buildchain_v4_wasm_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn buildchain_v4_wasm_alloc(length: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(length);
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn buildchain_v4_wasm_dealloc(pointer: *mut u8, length: usize) {
    if length == 0 {
        return;
    }
    // SAFETY: callers may release only buffers returned by buildchain_v4_wasm_alloc
    // with the same capacity supplied to that allocation.
    unsafe {
        drop(Vec::from_raw_parts(pointer, 0, length));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn buildchain_v4_wasm_invoke(pointer: *const u8, length: usize) {
    // SAFETY: the Node host writes exactly `length` initialized bytes into a
    // buffer returned by buildchain_v4_wasm_alloc before invoking this export.
    let input = unsafe { std::slice::from_raw_parts(pointer, length) };
    RESPONSE.with(|slot| {
        *slot.borrow_mut() = response_bytes(input);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn buildchain_v4_wasm_response_pointer() -> *const u8 {
    RESPONSE.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn buildchain_v4_wasm_response_length() -> usize {
    RESPONSE.with(|slot| slot.borrow().len())
}
