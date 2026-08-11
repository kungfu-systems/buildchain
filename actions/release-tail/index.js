import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";
import path from "node:path";

import {
  compileReleaseTailDeclaration,
  createReleaseTailAdapterSet,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  readReleaseTailTransaction,
  releaseTailRoot,
  writeReleaseTailTransaction,
} from "../../packages/core/release-tail-provider-plane.js";
import {
  ReleaseTailProviderError,
  createActivationReceiptProjectorAdapter,
  createGitHubReleaseAssetsAdapter,
  createHttpJsonReadback,
  createSignedStaticChannelAdapter,
  createSiteReleaseActivationAdapter,
} from "../../packages/core/release-tail-provider-adapters.js";

const BINDINGS_SCHEMA = "kungfu.buildchain.release-tail.provider-bindings/v1";

function input(name, required = false) {
  return core.getInput(name, { required }).trim();
}

function readJson(value, label) {
  const resolved = path.resolve(value);
  try {
    return fs.existsSync(resolved)
      ? JSON.parse(fs.readFileSync(resolved, "utf8"))
      : JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be JSON or a JSON file: ${error.message}`);
  }
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort().join("\n");
  const expected = [...fields].sort().join("\n");
  if (actual !== expected) {
    throw new Error(`${label} fields must be exactly: ${fields.join(", ")}`);
  }
}

function normalizeBindings(value) {
  exactFields(
    value,
    ["schema", "artifacts", "documents", "evidence"],
    "provider bindings",
  );
  if (value.schema !== BINDINGS_SCHEMA) {
    throw new Error(`provider bindings schema must be ${BINDINGS_SCHEMA}`);
  }
  for (const [role, binding] of Object.entries(value.artifacts || {})) {
    exactFields(binding, ["path", "name"], `artifact binding ${role}`);
    if (!binding.path || !binding.name) {
      throw new Error(`artifact binding ${role} requires path and name`);
    }
  }
  for (const [capabilityId, binding] of Object.entries(value.documents || {})) {
    exactFields(
      binding,
      ["path", "method"],
      `document binding ${capabilityId}`,
    );
    if (!binding.path || !["PUT", "POST"].includes(binding.method)) {
      throw new Error(
        `document binding ${capabilityId} requires path and PUT or POST method`,
      );
    }
  }
  exactFields(value.evidence, ["inputs", "output"], "evidence binding");
  if (!Array.isArray(value.evidence.inputs) || !value.evidence.output) {
    throw new Error("evidence binding requires inputs and output");
  }
  return structuredClone(value);
}

function resolveFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
  return resolved;
}

function readJsonFile(filePath, label) {
  return JSON.parse(fs.readFileSync(resolveFile(filePath, label), "utf8"));
}

function httpCallbacks({ capabilityId, binding, httpToken, readDocument }) {
  return {
    readDocument,
    resolveDocument() {
      return readJsonFile(binding.path, `${capabilityId} document`);
    },
    async commitDocument({
      locator,
      document,
      operationId,
      subjectRoot,
      authorityMove,
    }) {
      const url = new URL(locator);
      if (url.protocol !== "https:") {
        throw new ReleaseTailProviderError("provider mutation requires HTTPS", {
          code: "http-provider-https-required",
          classification: "conflict",
        });
      }
      const headers = {
        accept: "application/json",
        "content-type": "application/json",
        "x-buildchain-operation-id": operationId,
      };
      if (httpToken) headers.authorization = `Bearer ${httpToken}`;
      if (authorityMove === "signed-cas") headers["if-match"] = subjectRoot;
      let response;
      try {
        response = await fetch(url, {
          method: binding.method,
          headers,
          body: JSON.stringify(document),
        });
      } catch {
        throw new ReleaseTailProviderError(
          "provider mutation had a network failure",
          {
            code: "http-network-transient",
            classification: "transient",
          },
        );
      }
      if ([409, 412, 422].includes(response.status)) {
        throw new ReleaseTailProviderError(
          "provider rejected the conditional mutation",
          {
            code: "http-policy-conflict",
            classification: "conflict",
          },
        );
      }
      if (!response.ok) {
        throw new ReleaseTailProviderError(
          "provider mutation failed transiently",
          {
            code:
              response.status === 401 || response.status === 403
                ? "http-credential-transient"
                : "http-provider-transient",
            classification: "transient",
          },
        );
      }
    },
  };
}

function evidenceCallbacks(binding) {
  return {
    readEvidence(locator) {
      const resolved = path.resolve(locator);
      return fs.existsSync(resolved)
        ? JSON.parse(fs.readFileSync(resolved, "utf8"))
        : null;
    },
    synthesizeEvidence(effect) {
      const evidence = binding.inputs
        .map((filePath) => {
          const value = readJsonFile(filePath, "released evidence input");
          return {
            schema: String(value.schema || value.contract || "unknown"),
            root: releaseTailRoot(value),
          };
        })
        .sort((left, right) => left.root.localeCompare(right.root));
      return {
        schema: "kungfu.buildchain.released-evidence/v1",
        transactionRoot: effect.transactionRoot,
        operationId: effect.operationId,
        subjectRoot: effect.subjectRoot,
        evidence,
      };
    },
    writeEvidence({ locator, document }) {
      const resolved = path.resolve(locator || binding.output);
      if (resolved !== path.resolve(binding.output)) {
        throw new ReleaseTailProviderError(
          "evidence output does not match the declared locator",
          {
            code: "evidence-output-mismatch",
            classification: "conflict",
          },
        );
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(temporary, resolved);
    },
  };
}

function createAdapters(declaration, bindings, { githubToken, httpToken }) {
  const adapters = {};
  const capabilityIds = new Set(
    declaration.capabilities.map((entry) => entry.id),
  );
  if (capabilityIds.has("artifact.publish")) {
    if (!githubToken) throw new Error("artifact.publish requires github-token");
    adapters["github-release-assets"] = createGitHubReleaseAssetsAdapter({
      octokit: github.getOctokit(githubToken),
      resolveArtifact(role) {
        const binding = bindings.artifacts[role];
        if (!binding)
          throw new Error(`missing artifact binding for role ${role}`);
        return {
          ...binding,
          path: resolveFile(binding.path, `artifact ${role}`),
        };
      },
    });
  }
  const readDocument = createHttpJsonReadback();
  if (capabilityIds.has("signed-channel.commit")) {
    const binding = bindings.documents["signed-channel.commit"];
    if (!binding)
      throw new Error("missing signed-channel.commit document binding");
    const callbacks = httpCallbacks({
      capabilityId: "signed-channel.commit",
      binding,
      httpToken,
      readDocument,
    });
    adapters["signed-static-channel"] = createSignedStaticChannelAdapter({
      ...callbacks,
      commitDocument: callbacks.commitDocument,
    });
  }
  if (capabilityIds.has("release.activate")) {
    const binding = bindings.documents["release.activate"];
    if (!binding) throw new Error("missing release.activate document binding");
    const callbacks = httpCallbacks({
      capabilityId: "release.activate",
      binding,
      httpToken,
      readDocument,
    });
    adapters["site-release-activation"] = createSiteReleaseActivationAdapter({
      ...callbacks,
      activate: callbacks.commitDocument,
    });
  }
  if (capabilityIds.has("released-evidence.synthesize")) {
    adapters["activation-receipt-projector"] =
      createActivationReceiptProjectorAdapter(
        evidenceCallbacks(bindings.evidence),
      );
  }
  return createReleaseTailAdapterSet(declaration, adapters);
}

export async function executeAction({
  declaration,
  bindings,
  statePath,
  githubToken,
  httpToken,
  execute,
}) {
  const plan = compileReleaseTailDeclaration(declaration);
  let transaction = fs.existsSync(statePath)
    ? readReleaseTailTransaction(statePath)
    : createReleaseTailTransaction(plan);
  if (
    transaction.declarationRoot !== plan.declarationRoot ||
    transaction.planRoot !== plan.planRoot
  ) {
    throw new Error(
      "existing release-tail state does not belong to the declaration",
    );
  }
  writeReleaseTailTransaction(statePath, transaction);
  if (execute) {
    transaction = await executeReleaseTailTransaction(transaction, {
      adapters: createAdapters(declaration, bindings, {
        githubToken,
        httpToken,
      }),
      checkpoint: (checkpoint) =>
        writeReleaseTailTransaction(statePath, checkpoint),
    });
  }
  return transaction;
}

async function main() {
  const declaration = readJson(input("declaration", true), "declaration");
  const bindings = normalizeBindings(
    readJson(input("provider-bindings", true), "provider-bindings"),
  );
  const statePath = path.resolve(
    input("state-path") || ".buildchain/release-tail/state.json",
  );
  const transaction = await executeAction({
    declaration,
    bindings,
    statePath,
    githubToken: input("github-token"),
    httpToken: input("http-token"),
    execute: core.getBooleanInput("execute"),
  });
  core.setOutput("transaction-state", transaction.state);
  core.setOutput("transaction-root", transaction.transactionRoot);
  core.setOutput("state-root", transaction.stateRoot);
  core.setOutput("state-path", statePath);
  core.setOutput(
    "receipt-roots-json",
    JSON.stringify(transaction.receipts.map((receipt) => receipt.receiptRoot)),
  );
  if (!["complete", "prepared"].includes(transaction.state)) {
    throw new Error(
      `release-tail transaction stopped in ${transaction.state}: ${transaction.failure?.code || "unknown"}`,
    );
  }
}

main().catch((error) => core.setFailed(error.message));
