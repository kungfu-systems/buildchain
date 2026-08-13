import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
} from "./adopter-delivery-gate.js";

export const V4_ADOPTER_DELIVERY_PARITY_INPUT_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery-parity-input";
export const V4_ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT =
  "buildchain-v4-adopter-delivery-parity-projection/v1";

const HOST_REQUEST_CONTRACT = "kungfu-buildchain-v4-host-request";
const HOST_RESPONSE_CONTRACT = "kungfu-buildchain-v4-host-response";
const DRIVER_INTERFACE = "kungfu-buildchain-adopter-protocol-driver/v1";
const PROFILE_INTERFACE = "kungfu-buildchain-adopter-artifact-profile/v1";
const REQUIRED_CAPABILITIES = Object.freeze([
  "canonical-input-v1",
  "adopter-delivery-parity-projection-v1",
  "diagnostics-v1",
  "effects-disabled-v1",
  "structured-result-v1",
]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const V4_ADOPTER_DELIVERY_PARITY_SOURCE = Object.freeze({
  v3Commit: "c3f58d76391c1c6ceddfc900a68e91c7ab82a575",
  vectorSuiteRoot:
    "sha256:cf329805d928a9883cbafbdfdf21ef66c6a0889ed8dfe14356b4e0d25d6738f9",
  kfdPackage: "@kungfu-tech/kfd@1.0.0-alpha.62",
});

function clone(value) {
  return structuredClone(value);
}

function exactKey(definition) {
  return `${definition.id}@${definition.version}`;
}

function capture(operation) {
  try {
    return { state: "returned", result: clone(operation()) };
  } catch {
    return { state: "threw", result: null };
  }
}

function definition(definition, execution, { profile = false } = {}) {
  if (!definition) return null;
  return {
    interface: definition.interface,
    id: definition.id,
    version: definition.version,
    ...(profile ? { kinds: [...definition.kinds] } : {}),
    execution,
  };
}

export function createV4AdopterDeliveryParityInput({
  vectorId,
  request,
  context = {},
  drivers = [],
  artifactProfiles = [],
  sourceAuthority = V4_ADOPTER_DELIVERY_PARITY_SOURCE,
} = {}) {
  if (typeof vectorId !== "string" || vectorId.length === 0) {
    throw new TypeError("vectorId must be a non-empty string");
  }
  const gate = createAdopterDeliveryGate({ drivers, artifactProfiles });
  const expectedResult = gate.evaluate(clone(request), clone(context));
  const driver = drivers.find(
    (entry) =>
      exactKey(entry) === `${request.protocol.id}@${request.protocol.version}`,
  );
  const artifactProfile = artifactProfiles.find(
    (entry) =>
      exactKey(entry) ===
      `${request.artifactProfile.id}@${request.artifactProfile.version}`,
  );
  let profileExecution = null;
  if (artifactProfile?.kinds.includes(request.artifact.kind)) {
    profileExecution = capture(() =>
      artifactProfile.verify(clone(request.artifact)),
    );
  }
  let driverExecution = null;
  if (
    driver &&
    profileExecution?.state === "returned" &&
    profileExecution.result?.valid === true
  ) {
    driverExecution = capture(() =>
      driver.verify({ request: clone(request), context: clone(context) }),
    );
  }
  return {
    schemaVersion: 1,
    contract: V4_ADOPTER_DELIVERY_PARITY_INPUT_CONTRACT,
    vectorId,
    sourceAuthority: clone(sourceAuthority),
    request: clone(request),
    driver: definition(driver, driverExecution),
    artifactProfile: definition(artifactProfile, profileExecution, {
      profile: true,
    }),
    expectedResult,
  };
}

function hostRequest(input, timeoutMs) {
  return {
    schemaVersion: 1,
    contract: HOST_REQUEST_CONTRACT,
    protocolVersion: "1.0",
    requestId: crypto.randomUUID(),
    command: { id: "adopter-delivery.parity-project", arguments: [] },
    input: {
      encoding: "base64",
      bytes: Buffer.from(JSON.stringify(input), "utf8").toString("base64"),
    },
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    timeoutMs,
  };
}

export function runV4AdopterDeliveryParity(
  input,
  {
    command = process.platform === "win32" ? "cargo.exe" : "cargo",
    arguments: commandArguments = [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "host",
    ],
    cwd = root,
    timeoutMs = 30_000,
  } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("timeoutMs must be between 1 and 30000");
  }
  const request = hostRequest(input, timeoutMs);
  const completed = spawnSync(command, commandArguments, {
    cwd,
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_RESPONSE_BYTES,
    env: process.env,
  });
  if (completed.error) {
    throw new Error(
      `v4 adopter delivery parity host failed: ${completed.error.message}`,
    );
  }
  if (completed.status !== 0) {
    throw new Error(
      `v4 adopter delivery parity host exited ${completed.status}: ${completed.stderr.trim()}`,
    );
  }
  let response;
  try {
    response = JSON.parse(completed.stdout);
  } catch {
    throw new Error("v4 adopter delivery parity host returned invalid JSON");
  }
  if (
    response.schemaVersion !== 1 ||
    response.contract !== HOST_RESPONSE_CONTRACT ||
    response.protocolVersion !== "1.0" ||
    response.requestId !== request.requestId ||
    response.command?.id !== request.command.id ||
    response.status !== "ok"
  ) {
    const code = response.diagnostics?.[0]?.code || "invalid-response";
    throw new Error(`v4 adopter delivery parity failed closed: ${code}`);
  }
  const projection = response.structuredResult;
  if (
    projection?.schema !== V4_ADOPTER_DELIVERY_PARITY_PROJECTION_CONTRACT ||
    projection.effectMode !== "disabled" ||
    projection.vectorId !== input.vectorId ||
    !/^sha256:[0-9a-f]{64}$/u.test(projection.projectionRoot || "")
  ) {
    throw new Error("v4 adopter delivery parity projection is invalid");
  }
  return projection;
}

export function assertV4AdopterDeliveryParity(input, options = {}) {
  const projection = runV4AdopterDeliveryParity(input, options);
  if (
    adopterDeliveryGateDigest(projection.result) !==
    adopterDeliveryGateDigest(input.expectedResult)
  ) {
    throw new Error(
      "v4 adopter delivery parity result differs from v3 authority",
    );
  }
  return projection;
}

export const V4_ADOPTER_DELIVERY_PARITY_INTERFACES = Object.freeze({
  driver: DRIVER_INTERFACE,
  artifactProfile: PROFILE_INTERFACE,
});
