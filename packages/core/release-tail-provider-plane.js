import fs from "node:fs";
import path from "node:path";

import { invokeV4DomainWasm } from "./v4-domain-wasm.js";
import { RELEASE_TAIL_PRODUCT_CAPABILITIES } from "./release-tail-product-capabilities.js";

export const RELEASE_TAIL_DECLARATION_CONTRACT =
  "kungfu-buildchain-release-tail-capabilities";
export const RELEASE_TAIL_TRANSACTION_POLICY = "buildchain.release-tail/v1";
export const RELEASE_TAIL_TRANSACTION_SCHEMA =
  "kungfu.buildchain.release-tail.transaction/v1";
export const RELEASE_TAIL_EFFECT_SCHEMA =
  "kungfu.buildchain.release-tail.effect/v1";
export const RELEASE_TAIL_OBSERVATION_SCHEMA =
  "kungfu.buildchain.release-tail.observation/v1";
export const RELEASE_TAIL_RECEIPT_SCHEMA =
  "kungfu.buildchain.release-tail.receipt/v1";

export const RELEASE_TAIL_STATES = Object.freeze([
  "preparing",
  "prepared",
  "publishing",
  "committing",
  "activating",
  "reading-back",
  "settling",
  "complete",
  "blocked",
  "repair-required",
  "terminal-failure",
]);

export const RELEASE_TAIL_CAPABILITY_REGISTRY = Object.freeze([
  ...RELEASE_TAIL_PRODUCT_CAPABILITIES,
  Object.freeze({
    id: "artifact.publish",
    executor: "provider-adapter",
    adapter: "github-release-assets",
    effectKind: "artifact-publication",
    observationKind: "artifact-publication-readback",
    receiptKind: "artifact-publication",
    transactionState: "publishing",
  }),
  Object.freeze({
    id: "signed-channel.commit",
    executor: "provider-adapter",
    adapter: "signed-static-channel",
    effectKind: "signed-channel-commit",
    observationKind: "signed-channel-readback",
    receiptKind: "publication-commit",
    transactionState: "committing",
  }),
  Object.freeze({
    id: "release.activate",
    executor: "provider-adapter",
    adapter: "site-release-activation",
    effectKind: "release-activation",
    observationKind: "production-readback",
    receiptKind: "activation-receipt-set",
    transactionState: "activating",
  }),
  Object.freeze({
    id: "released-evidence.synthesize",
    executor: "buildchain-core",
    adapter: "activation-receipt-projector",
    effectKind: "released-evidence-projection",
    observationKind: "released-evidence-validation",
    receiptKind: "released-evidence",
    transactionState: "settling",
  }),
]);

export function releaseTailStableJson(value) {
  const canonical = invokeV4DomainWasm("canonical-json", value).canonicalUtf8;
  return canonical.endsWith("\n") ? canonical.slice(0, -1) : canonical;
}

export function releaseTailRoot(value) {
  return invokeV4DomainWasm("release-tail-root", value).root;
}

export function parseReleaseTailDeclaration(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new Error(
        `invalid release-tail declaration: input is not valid JSON: ${error.message}`,
      );
    }
  }
  return invokeV4DomainWasm("release-tail-parse", value);
}

export function compileReleaseTailDeclaration(input) {
  return invokeV4DomainWasm(
    "release-tail-compile",
    typeof input === "string" ? JSON.parse(input) : input,
  );
}

export function validateReleaseTailEffectPlan(plan) {
  return invokeV4DomainWasm("release-tail-validate-plan", plan);
}

export function createReleaseTailTransaction(input) {
  return invokeV4DomainWasm("release-tail-create", input);
}

export function validateReleaseTailTransaction(transaction) {
  return invokeV4DomainWasm("release-tail-validate-transaction", transaction);
}

export function readReleaseTailTransaction(filePath) {
  const transaction = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const validation = validateReleaseTailTransaction(transaction);
  if (!validation.valid) {
    throw new Error(
      `invalid release-tail transaction: ${validation.issues.join("; ")}`,
    );
  }
  return transaction;
}

export function writeReleaseTailTransaction(filePath, transaction) {
  const validation = validateReleaseTailTransaction(transaction);
  if (!validation.valid) {
    throw new Error(
      `invalid release-tail transaction: ${validation.issues.join("; ")}`,
    );
  }
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(transaction, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, resolved);
  return resolved;
}

async function emitCheckpoints(callback, checkpoints) {
  if (!callback) return;
  for (const checkpoint of checkpoints) {
    await callback(structuredClone(checkpoint));
  }
}

function adapterFor(adapters, effect) {
  const adapter = adapters?.[effect.adapter];
  if (
    !adapter ||
    typeof adapter.readback !== "function" ||
    typeof adapter.apply !== "function"
  ) {
    throw new Error(
      `release-tail adapter '${effect.adapter}' must provide readback and apply`,
    );
  }
  return adapter;
}

function providerFailure(error, fallback) {
  return {
    classification:
      error?.releaseTailClass === "conflict" ? "conflict" : "transient",
    code: error?.releaseTailCode || fallback,
  };
}

export async function executeReleaseTailTransaction(
  transaction,
  { adapters, checkpoint } = {},
) {
  let exchange = invokeV4DomainWasm(
    "release-tail-execution-start",
    transaction,
  );
  await emitCheckpoints(checkpoint, exchange.checkpoints);
  while (exchange.instruction.action !== "done") {
    const { instruction } = exchange;
    const adapter = adapterFor(adapters, instruction.effect);
    let signal;
    if (instruction.action === "readback") {
      let raw;
      try {
        raw = await adapter.readback(structuredClone(instruction.effect));
      } catch (error) {
        const failure = providerFailure(error, "readback-error");
        raw = {
          outcome:
            failure.classification === "conflict" ? "conflict" : "transient",
          providerCode: failure.code,
        };
      }
      signal = {
        kind: "readback",
        phase: instruction.phase,
        raw,
      };
    } else if (instruction.action === "apply") {
      try {
        await adapter.apply(structuredClone(instruction.effect));
        signal = { kind: "apply", classification: "success", code: "" };
      } catch (error) {
        signal = {
          kind: "apply",
          ...providerFailure(error, "provider-apply-error"),
        };
      }
    } else {
      throw new Error(
        `unsupported Rust/WASM release-tail instruction '${instruction.action}'`,
      );
    }
    exchange = invokeV4DomainWasm("release-tail-execution-advance", {
      transaction: exchange.transaction,
      cursor: exchange.cursor,
      signal,
    });
    await emitCheckpoints(checkpoint, exchange.checkpoints);
  }
  return exchange.transaction;
}

export function releaseTailRetryPolicyFromDeclaration(input) {
  const declaration = parseReleaseTailDeclaration(input);
  return Object.fromEntries(
    declaration.capabilities.map((capability) => [
      capability.id,
      capability.retry,
    ]),
  );
}

export function createReleaseTailAdapterSet(declaration, adapters) {
  const parsed = parseReleaseTailDeclaration(declaration);
  const result = { declarations: {} };
  for (const capability of parsed.capabilities) {
    const adapter = adapters?.[capability.adapter];
    if (!adapter)
      throw new Error(`missing release-tail adapter: ${capability.adapter}`);
    result[capability.adapter] = adapter;
    result.declarations[capability.id] = { retry: capability.retry };
  }
  return result;
}
