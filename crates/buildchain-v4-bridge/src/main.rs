use std::env;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const REQUEST_CONTRACT: &str = "kungfu-buildchain-v4-host-request";
const RESPONSE_CONTRACT: &str = "kungfu-buildchain-v4-host-response";
const PROTOCOL_VERSION: &str = "1.0";
const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const SOFTWARE_EXIT: i32 = 70;
const DATA_EXIT: i32 = 65;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedBytes {
    encoding: String,
    bytes: String,
}

impl EncodedBytes {
    fn empty() -> Self {
        Self {
            encoding: "base64".to_owned(),
            bytes: String::new(),
        }
    }

    fn from_bytes(value: &[u8]) -> Self {
        Self {
            encoding: "base64".to_owned(),
            bytes: BASE64.encode(value),
        }
    }

    fn decode(&self) -> Result<Vec<u8>, String> {
        if self.encoding != "base64" {
            return Err(format!("unsupported byte encoding: {}", self.encoding));
        }
        BASE64
            .decode(&self.bytes)
            .map_err(|error| format!("invalid base64 bytes: {error}"))
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostCommand {
    id: String,
    arguments: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostIdentity {
    kind: String,
    implementation: String,
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostOutput {
    stdout: EncodedBytes,
    stderr: EncodedBytes,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diagnostic {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExitSemantics {
    code: u8,
    signal: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostResponse {
    schema_version: u8,
    contract: String,
    protocol_version: String,
    request_id: String,
    status: String,
    host: HostIdentity,
    command: HostCommand,
    output: HostOutput,
    structured_result: Value,
    diagnostics: Vec<Diagnostic>,
    exit: ExitSemantics,
}

impl HostResponse {
    fn bridge_failure(request: &HostRequest, code: &str, message: String, exit: u8) -> Self {
        Self {
            schema_version: 1,
            contract: RESPONSE_CONTRACT.to_owned(),
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request.request_id.clone(),
            status: "failed".to_owned(),
            host: HostIdentity {
                kind: "node-subprocess".to_owned(),
                implementation: "unavailable".to_owned(),
                capabilities: Vec::new(),
            },
            command: request.command.clone(),
            output: HostOutput {
                stdout: EncodedBytes::empty(),
                stderr: EncodedBytes::from_bytes(message.as_bytes()),
            },
            structured_result: Value::Null,
            diagnostics: vec![Diagnostic {
                code: code.to_owned(),
                message,
                retryable: false,
            }],
            exit: ExitSemantics {
                code: exit,
                signal: None,
            },
        }
    }

    fn cancelled(request: &HostRequest, reason: &str, exit: u8, signal: Option<&str>) -> Self {
        Self {
            schema_version: 1,
            contract: RESPONSE_CONTRACT.to_owned(),
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request.request_id.clone(),
            status: "cancelled".to_owned(),
            host: HostIdentity {
                kind: "node-subprocess".to_owned(),
                implementation: "buildchain-v4-mjs-adapter".to_owned(),
                capabilities: Vec::new(),
            },
            command: request.command.clone(),
            output: HostOutput {
                stdout: EncodedBytes::empty(),
                stderr: EncodedBytes::empty(),
            },
            structured_result: Value::Null,
            diagnostics: vec![Diagnostic {
                code: reason.to_owned(),
                message: "the bridge terminated and reaped the host process".to_owned(),
                retryable: true,
            }],
            exit: ExitSemantics {
                code: exit,
                signal: signal.map(str::to_owned),
            },
        }
    }
}

fn validate_request(request: &HostRequest) -> Result<(), String> {
    if request.schema_version != 1 || request.contract != REQUEST_CONTRACT {
        return Err("unsupported request contract".to_owned());
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported protocol version: {}",
            request.protocol_version
        ));
    }
    if request.request_id.trim().is_empty() || request.command.id.trim().is_empty() {
        return Err("requestId and command.id must be non-empty".to_owned());
    }
    if !(1..=30_000).contains(&request.timeout_ms) {
        return Err("timeoutMs must be between 1 and 30000".to_owned());
    }
    let input = request.input.decode()?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err(format!("canonical input exceeds {MAX_REQUEST_BYTES} bytes"));
    }
    Ok(())
}

fn read_bounded(
    mut reader: impl Read + Send + 'static,
    limit: u64,
) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut value = Vec::new();
        reader.by_ref().take(limit + 1).read_to_end(&mut value)?;
        if value.len() as u64 > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("host output exceeds {limit} bytes"),
            ));
        }
        Ok(value)
    })
}

fn execute(request: &HostRequest, serialized_request: &[u8]) -> HostResponse {
    let command = env::var("BUILDCHAIN_V4_HOST_COMMAND").unwrap_or_else(|_| "node".to_owned());
    let script = env::var("BUILDCHAIN_V4_HOST_SCRIPT")
        .unwrap_or_else(|_| "scripts/v4-host-adapter.mjs".to_owned());
    let mut child = match Command::new(&command)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return HostResponse::bridge_failure(
                request,
                "host-spawn-failed",
                format!("failed to start host command {command}: {error}"),
                SOFTWARE_EXIT as u8,
            );
        }
    };

    let stdout = read_bounded(
        child.stdout.take().expect("piped stdout"),
        MAX_RESPONSE_BYTES,
    );
    let stderr = read_bounded(
        child.stderr.take().expect("piped stderr"),
        MAX_RESPONSE_BYTES,
    );
    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(serialized_request)
    {
        let _ = child.kill();
        let _ = child.wait();
        return HostResponse::bridge_failure(
            request,
            "host-input-failed",
            format!("failed to send canonical request to host: {error}"),
            SOFTWARE_EXIT as u8,
        );
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let signal_seen = Arc::clone(&cancelled);
    if let Err(error) = ctrlc::set_handler(move || signal_seen.store(true, Ordering::SeqCst)) {
        let _ = child.kill();
        let _ = child.wait();
        return HostResponse::bridge_failure(
            request,
            "signal-handler-failed",
            format!("failed to install cancellation handler: {error}"),
            SOFTWARE_EXIT as u8,
        );
    }

    let started = Instant::now();
    let timeout = Duration::from_millis(request.timeout_ms);
    let status = loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return HostResponse::cancelled(request, "host-cancelled", 130, Some("SIGINT"));
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return HostResponse::cancelled(request, "host-timeout", 124, None);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return HostResponse::bridge_failure(
                    request,
                    "host-wait-failed",
                    format!("failed while waiting for host: {error}"),
                    SOFTWARE_EXIT as u8,
                );
            }
        }
    };

    let stdout = match stdout.join() {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            return HostResponse::bridge_failure(
                request,
                "host-output-invalid",
                error.to_string(),
                SOFTWARE_EXIT as u8,
            );
        }
        Err(_) => {
            return HostResponse::bridge_failure(
                request,
                "host-output-reader-panicked",
                "host stdout reader panicked".to_owned(),
                SOFTWARE_EXIT as u8,
            );
        }
    };
    let stderr = match stderr.join() {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            return HostResponse::bridge_failure(
                request,
                "host-diagnostics-invalid",
                error.to_string(),
                SOFTWARE_EXIT as u8,
            );
        }
        Err(_) => {
            return HostResponse::bridge_failure(
                request,
                "host-diagnostics-reader-panicked",
                "host stderr reader panicked".to_owned(),
                SOFTWARE_EXIT as u8,
            );
        }
    };

    if !status.success() {
        let code = status.code().unwrap_or(SOFTWARE_EXIT).clamp(1, 255) as u8;
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return HostResponse::bridge_failure(
            request,
            "host-crashed",
            if detail.is_empty() {
                format!("host exited before returning a response: {status}")
            } else {
                format!("host exited before returning a response: {status}: {detail}")
            },
            code,
        );
    }

    let mut response: HostResponse = match serde_json::from_slice(&stdout) {
        Ok(value) => value,
        Err(error) => {
            return HostResponse::bridge_failure(
                request,
                "host-response-invalid",
                format!("host returned invalid response JSON: {error}"),
                SOFTWARE_EXIT as u8,
            );
        }
    };
    if response.schema_version != 1
        || response.contract != RESPONSE_CONTRACT
        || response.protocol_version != PROTOCOL_VERSION
        || response.request_id != request.request_id
        || response.command.id != request.command.id
    {
        return HostResponse::bridge_failure(
            request,
            "host-response-mismatch",
            "host response does not match the request contract and correlation identity".to_owned(),
            SOFTWARE_EXIT as u8,
        );
    }
    if let Err(error) = response.output.stdout.decode() {
        return HostResponse::bridge_failure(
            request,
            "host-stdout-invalid",
            error,
            SOFTWARE_EXIT as u8,
        );
    }
    if let Err(error) = response.output.stderr.decode() {
        return HostResponse::bridge_failure(
            request,
            "host-stderr-invalid",
            error,
            SOFTWARE_EXIT as u8,
        );
    }
    if !stderr.is_empty() {
        response.diagnostics.push(Diagnostic {
            code: "host-transport-diagnostic".to_owned(),
            message: String::from_utf8_lossy(&stderr).trim().to_owned(),
            retryable: false,
        });
    }
    response
}

fn run() -> Result<i32, String> {
    let mode = env::args().nth(1).unwrap_or_else(|| "exchange".to_owned());
    if !["exchange", "compat"].contains(&mode.as_str()) {
        return Err("usage: buildchain-v4-bridge [exchange|compat]".to_owned());
    }
    let mut serialized = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES * 2 + 1)
        .read_to_end(&mut serialized)
        .map_err(|error| format!("failed to read request: {error}"))?;
    if serialized.len() as u64 > MAX_REQUEST_BYTES * 2 {
        return Err("serialized request exceeds the bounded transport limit".to_owned());
    }
    let request: HostRequest = serde_json::from_slice(&serialized)
        .map_err(|error| format!("invalid host request: {error}"))?;
    validate_request(&request)?;
    let response = execute(&request, &serialized);
    if mode == "exchange" {
        serde_json::to_writer(io::stdout().lock(), &response)
            .map_err(|error| format!("failed to write response: {error}"))?;
        println!();
        return Ok(0);
    }
    io::stdout()
        .write_all(&response.output.stdout.decode()?)
        .map_err(|error| format!("failed to write command stdout: {error}"))?;
    io::stderr()
        .write_all(&response.output.stderr.decode()?)
        .map_err(|error| format!("failed to write command stderr: {error}"))?;
    Ok(i32::from(response.exit.code))
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("buildchain-v4-bridge: {error}");
            std::process::exit(DATA_EXIT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_transport_fields() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "contract": REQUEST_CONTRACT,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": "fixture",
            "command": { "id": "fixture.echo", "arguments": [] },
            "input": { "encoding": "base64", "bytes": "" },
            "requiredCapabilities": [],
            "timeoutMs": 1000,
            "credentials": { "token": "must-not-cross-contract" }
        });
        assert!(serde_json::from_value::<HostRequest>(value).is_err());
    }

    #[test]
    fn validates_canonical_input_bytes() {
        let request = HostRequest {
            schema_version: 1,
            contract: REQUEST_CONTRACT.to_owned(),
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: "fixture".to_owned(),
            command: HostCommand {
                id: "fixture.echo".to_owned(),
                arguments: Vec::new(),
            },
            input: EncodedBytes::from_bytes(b"hello"),
            required_capabilities: Vec::new(),
            timeout_ms: 1000,
        };
        assert_eq!(request.input.decode().unwrap(), b"hello");
        assert!(validate_request(&request).is_ok());
    }
}
