use std::env;
use std::fs;
use std::io::Read;

use buildchain_v4_contracts::{
    EventEnvelope, ReceiptEnvelope, canonical_bytes, content_root,
    run_delivery_warrant_trace_fixture, validate_clock,
};
use serde::Serialize;
use serde_json::Value;

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

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [fixture_path] => run_canonical_fixture(fixture_path),
        [command, fixture_path] if command == "trace" => run_trace_fixture(fixture_path),
        _ => Err("usage: buildchain-v4-contracts [trace] FIXTURES.json".to_owned()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("buildchain-v4-contracts: {error}");
        std::process::exit(65);
    }
}
