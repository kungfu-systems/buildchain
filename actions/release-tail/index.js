import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";
import path from "node:path";

import {
  createReleaseTailAdapterSet,
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
import {
  PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  executePublicationRehearsal,
  publicationRehearsalDiagnostic,
  resolvePublicationRehearsalFile,
} from "../../packages/core/publication-rehearsal-runtime.js";

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

function resolveFile(filePath, label, capsuleRoot) {
  return resolvePublicationRehearsalFile(capsuleRoot, filePath);
}

function readJsonFile(filePath, label, capsuleRoot) {
  return JSON.parse(
    fs.readFileSync(resolveFile(filePath, label, capsuleRoot), "utf8"),
  );
}

function httpCallbacks({
  capabilityId,
  binding,
  httpToken,
  readDocument,
  capsuleRoot,
}) {
  return {
    readDocument,
    resolveDocument() {
      return readJsonFile(
        binding.path,
        `${capabilityId} document`,
        capsuleRoot,
      );
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

function evidenceCallbacks(binding, capsuleRoot) {
  return {
    readEvidence(locator) {
      const resolved = resolvePublicationRehearsalFile(
        capsuleRoot,
        locator || binding.output,
        { mustExist: false },
      );
      return fs.existsSync(resolved)
        ? JSON.parse(fs.readFileSync(resolved, "utf8"))
        : null;
    },
    synthesizeEvidence(effect) {
      const evidence = binding.inputs
        .map((filePath) => {
          const value = readJsonFile(
            filePath,
            "released evidence input",
            capsuleRoot,
          );
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
      const resolved = resolvePublicationRehearsalFile(
        capsuleRoot,
        locator || binding.output,
        { mustExist: false },
      );
      const expected = resolvePublicationRehearsalFile(
        capsuleRoot,
        binding.output,
        { mustExist: false },
      );
      if (resolved !== expected) {
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

function createAdapters(
  declaration,
  bindings,
  { githubToken, httpToken, capsuleRoot },
) {
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
          path: resolveFile(binding.path, `artifact ${role}`, capsuleRoot),
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
      capsuleRoot,
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
      capsuleRoot,
    });
    adapters["site-release-activation"] = createSiteReleaseActivationAdapter({
      ...callbacks,
      activate: callbacks.commitDocument,
    });
  }
  if (capabilityIds.has("released-evidence.synthesize")) {
    adapters["activation-receipt-projector"] =
      createActivationReceiptProjectorAdapter(
        evidenceCallbacks(bindings.evidence, capsuleRoot),
      );
  }
  return createReleaseTailAdapterSet(declaration, adapters);
}

export async function executeAction({
  capsule,
  capsuleRoot,
  statePath,
  evidencePath,
  githubToken,
  httpToken,
}) {
  const transaction = fs.existsSync(statePath)
    ? readReleaseTailTransaction(statePath)
    : undefined;
  let result;
  try {
    result = await executePublicationRehearsal({
      capsule,
      capsuleRoot,
      mode: "provider",
      environment: {},
      transaction,
      adapters: createAdapters(capsule.declaration, capsule.providerBindings, {
        githubToken,
        httpToken,
        capsuleRoot,
      }),
      checkpoint: (checkpoint) =>
        writeReleaseTailTransaction(statePath, checkpoint),
    });
  } catch (error) {
    const diagnostic = publicationRehearsalDiagnostic(error, { capsule });
    outputJson(evidencePath, diagnostic);
    throw error;
  }
  writeReleaseTailTransaction(statePath, result.transaction);
  outputJson(evidencePath, result.evidence);
  return result;
}

function outputJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const capsulePath = input("capsule", true);
  if (!path.isAbsolute(capsulePath)) {
    throw new Error("capsule input must be an explicit absolute path");
  }
  const capsule = readJson(capsulePath, "capsule");
  if (
    input("capsule-contract", true) !== PUBLICATION_REHEARSAL_CAPSULE_CONTRACT
  ) {
    throw new Error("capsule-contract input is stale or unsupported");
  }
  const capsuleRoot = input("capsule-root", true);
  const statePath = input("state-path", true);
  const evidencePath = input("evidence-path", true);
  for (const [name, value] of Object.entries({
    "capsule-root": capsuleRoot,
    "state-path": statePath,
    "evidence-path": evidencePath,
  })) {
    if (!path.isAbsolute(value)) {
      throw new Error(`${name} input must be an explicit absolute path`);
    }
  }
  const result = await executeAction({
    capsule,
    capsuleRoot,
    statePath,
    evidencePath,
    githubToken: input("github-token"),
    httpToken: input("http-token"),
  });
  const transaction = result.transaction;
  core.setOutput("transaction-state", transaction.state);
  core.setOutput("transaction-root", transaction.transactionRoot);
  core.setOutput("state-root", transaction.stateRoot);
  core.setOutput("state-path", statePath);
  core.setOutput("evidence-path", evidencePath);
  core.setOutput("binding-root", result.evidence.bindingRoot);
  core.setOutput("evidence-root", result.evidence.evidenceRoot);
  core.setOutput(
    "receipt-roots-json",
    JSON.stringify(transaction.receipts.map((receipt) => receipt.receiptRoot)),
  );
  if (transaction.state !== "complete") {
    throw new Error(
      `release-tail transaction stopped in ${transaction.state}: ${transaction.failure?.code || "unknown"}`,
    );
  }
}

main().catch((error) => core.setFailed(error.message));
