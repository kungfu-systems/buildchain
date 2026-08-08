import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runV4DeliveryWarrantTraceFixture } from "./v4-delivery-warrant-fixture-runner.js";

export const V4_DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT =
  "buildchain-v4-delivery-warrant-shadow-observation/v1";
export const V4_DELIVERY_WARRANT_SHADOW_RESULT_CONTRACT =
  "buildchain-v4-delivery-warrant-shadow-result/v1";

const HOST_REQUEST_CONTRACT = "kungfu-buildchain-v4-host-request";
const HOST_RESPONSE_CONTRACT = "kungfu-buildchain-v4-host-response";
const PROJECTION_CONTRACT =
  "buildchain-v4-delivery-warrant-semantic-projection/v1";
const REQUIRED_CAPABILITIES = Object.freeze([
  "canonical-input-v1",
  "delivery-warrant-trace-projection-v1",
  "diagnostics-v1",
  "effects-disabled-v1",
  "structured-result-v1",
]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const RETENTION_DAYS = 90;
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

class ShadowHostFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShadowHostFault";
    this.code = code;
  }
}

function inputBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError("shadow input must be bytes or a UTF-8 string");
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function diagnostic(code, retryable = false) {
  const messages = {
    "host-cancelled": "the non-authoritative Rust projection was cancelled",
    "host-crashed": "the non-authoritative Rust projection host exited",
    "host-response-invalid": "the Rust host response was malformed",
    "host-response-mismatch": "the Rust host response correlation was invalid",
    "host-spawn-failed":
      "the non-authoritative Rust projection host could not start",
    "host-timeout":
      "the non-authoritative Rust projection exceeded its bounded timeout",
    "input-not-public-safe":
      "shadow input was not eligible for public-safe retention",
    "retention-failed":
      "the caller-owned shadow observation sink rejected the observation",
    "rust-projection-failed":
      "the Rust host did not produce a usable projection",
    "shadow-config-invalid":
      "the non-authoritative shadow configuration was invalid",
    "shadow-disabled": "the non-authoritative Rust shadow is disabled",
    "unsupported-capability":
      "the Rust host did not support the effect-disabled projection contract",
  };
  return {
    code,
    message: messages[code] || "the Rust shadow was unavailable",
    retryable,
  };
}

function enabledByDefault(environment = process.env) {
  return environment.BUILDCHAIN_V4_WARRANT_SHADOW === "enabled";
}

function publicRetention(retention = {}) {
  if (retention.kind === "fixture") {
    return { classification: "public-safe-fixture", publicSafe: true };
  }
  if (retention.kind === "captured-replay" && retention.publicSafe === true) {
    return { classification: "public-safe-captured-replay", publicSafe: true };
  }
  throw new ShadowHostFault(
    "input-not-public-safe",
    "only fixtures and explicitly public-safe captured replays may enter shadow retention",
  );
}

function exactSource(value, label) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an exact lowercase Git revision`);
  }
  return value;
}

function exactValidator(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw new TypeError("validatorVersion must be a public ASCII identifier");
  }
  return value;
}

function retainUntil(recordedAt) {
  const time = Date.parse(recordedAt);
  if (!Number.isFinite(time))
    throw new TypeError("recordedAt must be an ISO timestamp");
  return new Date(time + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function createV4DeliveryWarrantShadowRequest(
  bytes,
  { requestId = crypto.randomUUID(), timeoutMs = 5_000 } = {},
) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return {
    schemaVersion: 1,
    contract: HOST_REQUEST_CONTRACT,
    protocolVersion: "1.0",
    requestId,
    command: { id: "delivery-warrant.trace-project", arguments: [] },
    input: { encoding: "base64", bytes: inputBytes(bytes).toString("base64") },
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    timeoutMs,
  };
}

function validateHostResponse(response, request) {
  if (
    !response ||
    response.schemaVersion !== 1 ||
    response.contract !== HOST_RESPONSE_CONTRACT ||
    response.protocolVersion !== "1.0"
  ) {
    throw new ShadowHostFault(
      "host-response-invalid",
      "unsupported host response contract",
    );
  }
  if (
    response.requestId !== request.requestId ||
    response.command?.id !== request.command.id
  ) {
    throw new ShadowHostFault(
      "host-response-mismatch",
      "host response correlation mismatch",
    );
  }
  if (!Array.isArray(response.host?.capabilities)) {
    throw new ShadowHostFault(
      "host-response-invalid",
      "host capabilities are missing",
    );
  }
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !response.host.capabilities.includes(capability),
  );
  if (response.status === "unsupported" || missing.length > 0) {
    throw new ShadowHostFault(
      "unsupported-capability",
      "required host capability is missing",
    );
  }
  if (response.status !== "ok") {
    throw new ShadowHostFault(
      "rust-projection-failed",
      "Rust projection status was not ok",
    );
  }
  const result = response.structuredResult;
  if (
    result?.projection?.schema !== PROJECTION_CONTRACT ||
    !ROOT_PATTERN.test(String(result?.projectionRoot || ""))
  ) {
    throw new ShadowHostFault(
      "host-response-invalid",
      "Rust projection shape is invalid",
    );
  }
  return result;
}

function defaultHost() {
  return {
    command: "cargo",
    arguments: [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      path.join(root, "crates", "buildchain-v4-contracts", "Cargo.toml"),
      "--",
      "host",
    ],
  };
}

export function invokeV4RustShadowHost(
  request,
  { command, arguments: commandArguments, cwd = root, signal } = {},
) {
  const selected = defaultHost();
  const executable = command || selected.command;
  const args = commandArguments || selected.arguments;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new ShadowHostFault(
          "host-cancelled",
          "shadow signal was already aborted",
        ),
      );
      return;
    }
    let settled = false;
    let terminationCode = "";
    let stdoutBytes = 0;
    const stdout = [];
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      callback();
    };
    const terminate = (code) => {
      if (terminationCode) return;
      terminationCode = code;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 100);
      force.unref?.();
    };
    const cancel = () => terminate("host-cancelled");
    const timeout = setTimeout(
      () => terminate("host-timeout"),
      request.timeoutMs,
    );
    timeout.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", () => {
      finish(() =>
        reject(new ShadowHostFault("host-spawn-failed", "host spawn failed")),
      );
    });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES) {
        terminate("host-response-invalid");
        return;
      }
      stdout.push(chunk);
    });
    child.stdin.on("error", () => {
      terminate("host-crashed");
    });
    child.once("close", (code) => {
      finish(() => {
        if (terminationCode) {
          reject(
            new ShadowHostFault(
              terminationCode,
              "shadow host terminated and reaped",
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new ShadowHostFault(
              "host-crashed",
              "shadow host exited before a response",
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch {
          reject(
            new ShadowHostFault(
              "host-response-invalid",
              "shadow host returned invalid JSON",
            ),
          );
        }
      });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function skippedShadow(inputRoot, code) {
  return {
    status: "skipped",
    authority: "typescript-v3",
    rustAuthority: "none",
    rustEffects: "disabled",
    inputRoot,
    observation: null,
    diagnostics: [diagnostic(code)],
    retention: { status: "not-attempted" },
  };
}

export async function runV4DeliveryWarrantShadow(
  value,
  {
    enabled = enabledByDefault(),
    invokeLegacy = runV4DeliveryWarrantTraceFixture,
    invokeRust = invokeV4RustShadowHost,
    host = {},
    requestId,
    timeoutMs = 5_000,
    signal,
    retention = { kind: "fixture" },
    retain,
    recordedAt = new Date().toISOString(),
    sources = {},
  } = {},
) {
  const bytes = inputBytes(value);
  const authoritativeResult = await invokeLegacy(Buffer.from(bytes));
  const inputRoot = sha256(bytes);
  if (!enabled) {
    return {
      schema: V4_DELIVERY_WARRANT_SHADOW_RESULT_CONTRACT,
      authoritativeResult,
      shadow: skippedShadow(inputRoot, "shadow-disabled"),
    };
  }

  let retentionScope;
  try {
    retentionScope = publicRetention(retention);
  } catch (error) {
    return {
      schema: V4_DELIVERY_WARRANT_SHADOW_RESULT_CONTRACT,
      authoritativeResult,
      shadow: skippedShadow(inputRoot, error.code || "input-not-public-safe"),
    };
  }

  let sourceBinding;
  let request;
  try {
    sourceBinding = {
      typescriptRevision: exactSource(
        sources.typescriptRevision,
        "typescriptRevision",
      ),
      rustRevision: exactSource(sources.rustRevision, "rustRevision"),
      validatorVersion: exactValidator(sources.validatorVersion),
    };
    request = createV4DeliveryWarrantShadowRequest(bytes, {
      requestId,
      timeoutMs,
    });
  } catch {
    return {
      schema: V4_DELIVERY_WARRANT_SHADOW_RESULT_CONTRACT,
      authoritativeResult,
      shadow: skippedShadow(inputRoot, "shadow-config-invalid"),
    };
  }
  let rustProjection = null;
  let status = "observed";
  const diagnostics = [];
  try {
    const response = await invokeRust(request, { ...host, signal });
    rustProjection = validateHostResponse(response, request);
  } catch (error) {
    const code =
      error instanceof ShadowHostFault ? error.code : "rust-projection-failed";
    diagnostics.push(diagnostic(code, code === "host-timeout"));
    status = code === "host-cancelled" ? "cancelled" : "unavailable";
  }

  const observation = {
    schema: V4_DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT,
    authority: "typescript-v3",
    rustAuthority: "none",
    rustEffects: "disabled",
    status,
    recordedAt,
    retainUntil: retainUntil(recordedAt),
    retention: retentionScope,
    input: {
      encoding: "base64",
      bytes: bytes.toString("base64"),
      root: inputRoot,
    },
    sources: sourceBinding,
    legacy: {
      sourceRevision: sourceBinding.typescriptRevision,
      projection: authoritativeResult,
    },
    rust: {
      sourceRevision: sourceBinding.rustRevision,
      projection: rustProjection,
    },
    diagnostics,
  };
  let retentionResult = { status: "returned-to-caller" };
  if (retain) {
    try {
      await retain(structuredClone(observation));
      retentionResult = { status: "retained" };
    } catch {
      diagnostics.push(diagnostic("retention-failed", true));
      retentionResult = { status: "failed" };
    }
  }
  return {
    schema: V4_DELIVERY_WARRANT_SHADOW_RESULT_CONTRACT,
    authoritativeResult,
    shadow: {
      status,
      authority: "typescript-v3",
      rustAuthority: "none",
      rustEffects: "disabled",
      inputRoot,
      observation,
      diagnostics,
      retention: retentionResult,
    },
  };
}
