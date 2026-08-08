use std::env;
use std::fs;
use std::io::Read;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use buildchain_v4_contracts::{
    EventEnvelope, ReceiptEnvelope, canonical_bytes, content_root,
    project_delivery_warrant_state_bytes, run_delivery_warrant_trace_fixture,
    run_stage_capsule_fixture, run_stage_capsule_store_fixture, validate_clock,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const HOST_REQUEST_CONTRACT: &str = "kungfu-buildchain-v4-host-request";
const HOST_RESPONSE_CONTRACT: &str = "kungfu-buildchain-v4-host-response";
const HOST_CAPABILITIES: &[&str] = &[
    "canonical-input-v1",
    "delivery-warrant-state-projection-v1",
    "delivery-warrant-trace-projection-v1",
    "diagnostics-v1",
    "effects-disabled-v1",
    "structured-result-v1",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRequest {
    schema_version: u8,
    contract: String,
    protocol_version: String,
    request_id: String,
    command: HostCommand,
    input: EncodedBytes,
    required_capabilities: Vec<String>,
    timeout_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostCommand {
    id: String,
    arguments: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedBytes {
    encoding: String,
    bytes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostIdentity {
    kind: &'static str,
    implementation: &'static str,
    capabilities: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostOutput {
    stdout: EncodedBytes,
    stderr: EncodedBytes,
}

#[derive(Serialize)]
struct Diagnostic {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitSemantics {
    code: u8,
    signal: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    schema_version: u8,
    contract: &'static str,
    protocol_version: &'static str,
    request_id: String,
    status: &'static str,
    host: HostIdentity,
    command: HostCommand,
    output: HostOutput,
    structured_result: Value,
    diagnostics: Vec<Diagnostic>,
    exit: ExitSemantics,
}

fn encoded_bytes(value: &[u8]) -> EncodedBytes {
    EncodedBytes {
        encoding: "base64".to_owned(),
        bytes: BASE64.encode(value),
    }
}

fn host_response(
    request: HostRequest,
    status: &'static str,
    structured_result: Value,
    diagnostics: Vec<Diagnostic>,
    exit: u8,
) -> HostResponse {
    HostResponse {
        schema_version: 1,
        contract: HOST_RESPONSE_CONTRACT,
        protocol_version: "1.0",
        request_id: request.request_id,
        status,
        host: HostIdentity {
            kind: "rust-subprocess",
            implementation: "buildchain-v4-contracts-shadow-host",
            capabilities: HOST_CAPABILITIES,
        },
        command: request.command,
        output: HostOutput {
            stdout: encoded_bytes(&[]),
            stderr: encoded_bytes(&[]),
        },
        structured_result,
        diagnostics,
        exit: ExitSemantics {
            code: exit,
            signal: None,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Projection {
    id: String,
    canonical_utf8: String,
    root: String,
    clock_valid: bool,
}

#[derive(Serialize)]
struct FaultProjection {
    id: String,
    fault: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureProjection {
    valid_cases: Vec<Projection>,
    invalid_cases: Vec<FaultProjection>,
}

fn run_canonical_fixture(fixture_path: &str) -> Result<(), String> {
    let fixtures: Value = serde_json::from_slice(
        &fs::read(fixture_path).map_err(|error| format!("cannot read fixtures: {error}"))?,
    )
    .map_err(|error| format!("invalid fixtures: {error}"))?;
    let cases = fixtures["validCases"]
        .as_array()
        .ok_or_else(|| "fixtures.validCases must be an array".to_owned())?;
    let valid_cases = cases
        .iter()
        .map(|case| {
            let id = case["id"]
                .as_str()
                .ok_or_else(|| "fixture id is required".to_owned())?;
            let domain = case["domain"]
                .as_str()
                .ok_or_else(|| format!("fixture {id} domain is required"))?;
            let clock = case["clock"]
                .as_str()
                .ok_or_else(|| format!("fixture {id} clock is required"))?;
            let value = &case["value"];
            Ok(Projection {
                id: id.to_owned(),
                canonical_utf8: String::from_utf8(
                    canonical_bytes(value).map_err(|error| error.message.clone())?,
                )
                .map_err(|error| error.to_string())?,
                root: content_root(domain, value).map_err(|error| error.message.clone())?,
                clock_valid: validate_clock(clock, "$.clock").is_ok(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let invalid_cases = fixtures["invalidCases"]
        .as_array()
        .ok_or_else(|| "fixtures.invalidCases must be an array".to_owned())?
        .iter()
        .map(|case| {
            let id = case["id"]
                .as_str()
                .ok_or_else(|| "invalid fixture id is required".to_owned())?;
            let kind = case["kind"]
                .as_str()
                .ok_or_else(|| format!("fixture {id} kind is required"))?;
            let value = &case["value"];
            let fault = match kind {
                "canonical" => canonical_bytes(value).err().map(|fault| fault.code.clone()),
                "clock" => value
                    .as_str()
                    .and_then(|clock| validate_clock(clock, "$.clock").err())
                    .map(|fault| fault.code.clone()),
                "root" => value
                    .as_str()
                    .and_then(|domain| content_root(domain, &serde_json::json!({})).err())
                    .map(|fault| fault.code.clone()),
                "event" => match serde_json::from_value::<EventEnvelope>(value.clone()) {
                    Ok(envelope) => envelope.validate().err().map(|fault| fault.code.clone()),
                    Err(_) => Some("invalid-envelope-shape".to_owned()),
                },
                "receipt" => match serde_json::from_value::<ReceiptEnvelope>(value.clone()) {
                    Ok(envelope) => envelope.validate().err().map(|fault| fault.code.clone()),
                    Err(_) => Some("invalid-envelope-shape".to_owned()),
                },
                _ => return Err(format!("fixture {id} has unsupported kind {kind}")),
            }
            .ok_or_else(|| format!("fixture {id} unexpectedly passed"))?;
            Ok(FaultProjection {
                id: id.to_owned(),
                fault,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let projection = FixtureProjection {
        valid_cases,
        invalid_cases,
    };
    serde_json::to_writer(std::io::stdout().lock(), &projection)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn run_trace_fixture(fixture_path: &str) -> Result<(), String> {
    let bytes = if fixture_path == "-" {
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read fixtures: {error}"))?;
        bytes
    } else {
        fs::read(fixture_path).map_err(|error| format!("cannot read fixtures: {error}"))?
    };
    let result = run_delivery_warrant_trace_fixture(&bytes)
        .map_err(|fault| format!("{} at {}: {}", fault.code, fault.path, fault.message))?;
    serde_json::to_writer(std::io::stdout().lock(), &result).map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn run_stage_capsule_fixtures(fixture_path: &str) -> Result<(), String> {
    let bytes = fs::read(fixture_path).map_err(|error| format!("cannot read fixtures: {error}"))?;
    let projection = run_stage_capsule_fixture(&bytes)
        .map_err(|fault| format!("{} at {}: {}", fault.code, fault.path, fault.message))?;
    serde_json::to_writer(std::io::stdout().lock(), &projection)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn run_stage_capsule_store_fixtures(fixture_path: &str) -> Result<(), String> {
    let bytes = fs::read(fixture_path).map_err(|error| format!("cannot read fixtures: {error}"))?;
    let projection = run_stage_capsule_store_fixture(&bytes)
        .map_err(|fault| format!("{} at {}: {}", fault.code, fault.path, fault.message))?;
    serde_json::to_writer(std::io::stdout().lock(), &projection)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn read_stdin() -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read stdin: {error}"))?;
    Ok(bytes)
}

fn run_shadow_host() -> Result<(), String> {
    let request: HostRequest = serde_json::from_slice(&read_stdin()?)
        .map_err(|error| format!("invalid host request: {error}"))?;
    if request.schema_version != 1
        || request.contract != HOST_REQUEST_CONTRACT
        || request.protocol_version != "1.0"
        || request.request_id.is_empty()
        || request.timeout_ms == 0
        || request.timeout_ms > 30_000
        || request.input.encoding != "base64"
    {
        return Err("unsupported host request contract".to_owned());
    }
    let unsupported = request
        .required_capabilities
        .iter()
        .filter(|capability| !HOST_CAPABILITIES.contains(&capability.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let supported_command = matches!(
        request.command.id.as_str(),
        "delivery-warrant.trace-project" | "delivery-warrant.state-project"
    );
    let response =
        if !unsupported.is_empty() || !supported_command || !request.command.arguments.is_empty() {
            host_response(
                request,
                "unsupported",
                Value::Null,
                vec![Diagnostic {
                    code: "unsupported-capability".to_owned(),
                    message: "the requested effect-disabled projection capability is unsupported"
                        .to_owned(),
                    retryable: false,
                }],
                64,
            )
        } else {
            let input = BASE64
                .decode(&request.input.bytes)
                .map_err(|_| "host input is not canonical base64".to_owned())?;
            let projected = match request.command.id.as_str() {
                "delivery-warrant.trace-project" => run_delivery_warrant_trace_fixture(&input)
                    .and_then(|value| {
                        serde_json::to_value(value).map_err(|error| {
                            Box::new(buildchain_v4_contracts::ContractFault {
                                schema: buildchain_v4_contracts::CONTRACT_FAULT_CONTRACT.to_owned(),
                                code: "projection-serialization-failed".to_owned(),
                                fault_class: "validation".to_owned(),
                                path: "$/projection".to_owned(),
                                message: error.to_string(),
                                retry: "stop".to_owned(),
                            })
                        })
                    }),
                "delivery-warrant.state-project" => project_delivery_warrant_state_bytes(&input)
                    .and_then(|value| {
                        serde_json::to_value(value).map_err(|error| {
                            Box::new(buildchain_v4_contracts::ContractFault {
                                schema: buildchain_v4_contracts::CONTRACT_FAULT_CONTRACT.to_owned(),
                                code: "projection-serialization-failed".to_owned(),
                                fault_class: "validation".to_owned(),
                                path: "$/projection".to_owned(),
                                message: error.to_string(),
                                retry: "stop".to_owned(),
                            })
                        })
                    }),
                _ => unreachable!(),
            };
            match projected {
                Ok(result) => host_response(request, "ok", result, Vec::new(), 0),
                Err(fault) => host_response(
                    request,
                    "failed",
                    Value::Null,
                    vec![Diagnostic {
                        code: fault.code,
                        message: "the retained trace failed closed validation".to_owned(),
                        retryable: false,
                    }],
                    65,
                ),
            }
        };
    serde_json::to_writer(std::io::stdout().lock(), &response)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "host" => run_shadow_host(),
        [fixture_path] => run_canonical_fixture(fixture_path),
        [command, fixture_path] if command == "trace" => run_trace_fixture(fixture_path),
        [command, fixture_path] if command == "stage-capsule" => {
            run_stage_capsule_fixtures(fixture_path)
        }
        [command, fixture_path] if command == "stage-capsule-store" => {
            run_stage_capsule_store_fixtures(fixture_path)
        }
        _ => Err("usage: buildchain-v4-contracts [trace|stage-capsule|stage-capsule-store FIXTURES.json|host]".to_owned()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("buildchain-v4-contracts: {error}");
        std::process::exit(65);
    }
}
