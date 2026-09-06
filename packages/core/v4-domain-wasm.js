import fs from "node:fs";
import { createHash } from "node:crypto";

import {
  V4_DOMAIN_WASM_ABI_VERSION,
  V4_DOMAIN_WASM_SHA256,
} from "./v4-domain-wasm-artifact.js";

export const V4_DOMAIN_WASM_REQUEST_CONTRACT =
  "kungfu-buildchain-v4-domain-wasm-request/v1";
export const V4_DOMAIN_WASM_RESPONSE_CONTRACT =
  "kungfu-buildchain-v4-domain-wasm-response/v1";

const WASM_URL = new URL("./buildchain-v4-domain.wasm", import.meta.url);
const REQUIRED_EXPORTS = [
  "memory",
  "buildchain_v4_wasm_abi_version",
  "buildchain_v4_wasm_alloc",
  "buildchain_v4_wasm_dealloc",
  "buildchain_v4_wasm_invoke",
  "buildchain_v4_wasm_response_pointer",
  "buildchain_v4_wasm_response_length",
];

let loaded;

export class V4DomainWasmFault extends Error {
  constructor(fault) {
    super(fault?.message || "Rust/WASM domain request failed");
    this.name = "V4DomainWasmFault";
    this.fault = fault;
    this.code = fault?.code || "rust-wasm-domain-failed";
    this.path = fault?.path || "$";
    this.retry = fault?.retry || "stop";
  }
}

function failClosed(message, cause) {
  const error = new Error(`Buildchain v4 Rust/WASM authority: ${message}`);
  error.code = "rust-wasm-authority-unavailable";
  error.cause = cause;
  throw error;
}

function invalidTransport(code, path, message) {
  throw new V4DomainWasmFault({ code, path, message, retry: "stop" });
}

function validateJsonTransport(value, path, active) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          invalidTransport(
            "unsupported-string",
            path,
            `${path} contains an unpaired surrogate`,
          );
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        invalidTransport(
          "unsupported-string",
          path,
          `${path} contains an unpaired surrogate`,
        );
      }
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      invalidTransport(
        "unsupported-number",
        path,
        `${path} must be a safe base-10 integer and must not be negative zero`,
      );
    }
    return;
  }
  if (!value || typeof value !== "object") {
    invalidTransport(
      "unsupported-json-value",
      path,
      `${path} is not a JSON value`,
    );
  }
  if (active.has(value)) {
    invalidTransport("cyclic-json-value", path, `${path} contains a cycle`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        validateJsonTransport(value[index], `${path}/${index}`, active);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidTransport(
        "unsupported-json-value",
        path,
        `${path} must be a plain object`,
      );
    }
    for (const key of Object.keys(value)) {
      if (!/^[\x20-\x7e]+$/u.test(key)) {
        invalidTransport(
          "unsupported-object-key",
          `${path}/${key}`,
          "object keys must be non-empty printable ASCII",
        );
      }
      validateJsonTransport(value[key], `${path}/${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function loadAuthority() {
  if (loaded) return loaded;
  let bytes;
  try {
    bytes = fs.readFileSync(WASM_URL);
  } catch (error) {
    failClosed(`cannot read ${WASM_URL.pathname}`, error);
  }
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (observedSha256 !== V4_DOMAIN_WASM_SHA256) {
    failClosed(
      `artifact digest mismatch (expected ${V4_DOMAIN_WASM_SHA256}, observed ${observedSha256})`,
    );
  }
  let instance;
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  } catch (error) {
    failClosed("artifact compilation or instantiation failed", error);
  }
  const missing = REQUIRED_EXPORTS.filter(
    (name) => instance.exports[name] === undefined,
  );
  if (missing.length > 0) {
    failClosed(`artifact is missing exports: ${missing.join(", ")}`);
  }
  const abiVersion = instance.exports.buildchain_v4_wasm_abi_version();
  if (abiVersion !== V4_DOMAIN_WASM_ABI_VERSION) {
    failClosed(
      `ABI mismatch (expected ${V4_DOMAIN_WASM_ABI_VERSION}, observed ${abiVersion})`,
    );
  }
  loaded = instance.exports;
  return loaded;
}

export function invokeV4DomainWasm(operation, payload) {
  if (
    ["canonical-json", "content-root", "release-tail-root"].includes(operation)
  ) {
    validateJsonTransport(payload, "$/payload", new Set());
  }
  const authority = loadAuthority();
  const input = new TextEncoder().encode(
    JSON.stringify({
      schema: V4_DOMAIN_WASM_REQUEST_CONTRACT,
      operation,
      payload,
    }),
  );
  const inputPointer = authority.buildchain_v4_wasm_alloc(input.byteLength);
  try {
    new Uint8Array(authority.memory.buffer, inputPointer, input.byteLength).set(
      input,
    );
    try {
      authority.buildchain_v4_wasm_invoke(inputPointer, input.byteLength);
    } catch (error) {
      failClosed(`operation '${operation}' trapped`, error);
    }
    const responsePointer = authority.buildchain_v4_wasm_response_pointer();
    const responseLength = authority.buildchain_v4_wasm_response_length();
    let response;
    try {
      const responseBytes = new Uint8Array(
        authority.memory.buffer,
        responsePointer,
        responseLength,
      );
      response = JSON.parse(new TextDecoder().decode(responseBytes));
    } catch (error) {
      failClosed(
        `operation '${operation}' returned an invalid response`,
        error,
      );
    }
    if (
      response?.schema !== V4_DOMAIN_WASM_RESPONSE_CONTRACT ||
      typeof response.ok !== "boolean"
    ) {
      failClosed(`operation '${operation}' returned an unsupported response`);
    }
    if (!response.ok) throw new V4DomainWasmFault(response.fault);
    return response.value;
  } finally {
    authority.buildchain_v4_wasm_dealloc(inputPointer, input.byteLength);
  }
}

export function v4DomainWasmInfo() {
  return invokeV4DomainWasm("abi-info", {});
}
