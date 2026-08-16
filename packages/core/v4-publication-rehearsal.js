import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  executeReleaseTailTransaction,
  releaseTailRoot,
  validateReleaseTailTransaction,
} from "./release-tail-provider-plane.js";
import {
  V4_PUBLICATION_REHEARSAL_AUTHORITY_CONTRACT,
  V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_CORE_VERSION,
  V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_PROVIDER_POLICY_CONTRACT,
  V4PublicationRehearsalFault,
  assertPublicationRehearsalExactKeys as exactKeys,
  createV4PublicationRehearsalCapsule,
  createV4PublicationRehearsalProviderPolicy,
  publicationRehearsalFault as fault,
  publicationRehearsalRoot,
  validateV4PublicationRehearsalCapsule,
  validateV4PublicationRehearsalProviderBindings,
} from "./v4-publication-rehearsal-capsule.js";

export {
  V4_PUBLICATION_REHEARSAL_AUTHORITY_CONTRACT,
  V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_CORE_VERSION,
  V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_PROVIDER_POLICY_CONTRACT,
  V4PublicationRehearsalFault,
  createV4PublicationRehearsalCapsule,
  createV4PublicationRehearsalProviderPolicy,
  validateV4PublicationRehearsalCapsule,
  validateV4PublicationRehearsalProviderBindings,
};

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const MODES = new Set(["simulate", "replay", "provider"]);

function fileRoot(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function resolveCandidateFile(candidateRootPath, relative, location) {
  const base = fs.realpathSync(candidateRootPath);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${base}${path.sep}`))
    fault(
      "publication-rehearsal-path-escape",
      location,
      "candidate path escapes the explicit root",
    );
  if (
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isFile() ||
    fs.lstatSync(resolved).isSymbolicLink() ||
    !fs.realpathSync(resolved).startsWith(`${base}${path.sep}`)
  )
    fault(
      "publication-rehearsal-file-missing",
      location,
      "regular in-root file required",
    );
  return resolved;
}

function resolveCandidateOutput(candidateRootPath, relative, location) {
  const base = fs.realpathSync(candidateRootPath);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${base}${path.sep}`))
    fault(
      "publication-rehearsal-path-escape",
      location,
      "candidate output escapes the explicit root",
    );
  for (
    let current = path.dirname(resolved);
    current !== base;
    current = path.dirname(current)
  ) {
    if (!fs.existsSync(current)) continue;
    if (
      fs.lstatSync(current).isSymbolicLink() ||
      !fs.statSync(current).isDirectory() ||
      !fs.realpathSync(current).startsWith(`${base}${path.sep}`)
    )
      fault(
        "publication-rehearsal-path-escape",
        location,
        "candidate output ancestor is not a regular in-root directory",
      );
  }
  if (
    fs.existsSync(resolved) &&
    (fs.lstatSync(resolved).isSymbolicLink() ||
      !fs.statSync(resolved).isFile() ||
      !fs.realpathSync(resolved).startsWith(`${base}${path.sep}`))
  )
    fault(
      "publication-rehearsal-path-escape",
      location,
      "candidate output is not a regular in-root file",
    );
  return resolved;
}

export function verifyV4PublicationRehearsalCapsule({
  capsule,
  candidateRoot: candidateRootPath,
}) {
  const normalized = validateV4PublicationRehearsalCapsule(capsule);
  if (!path.isAbsolute(candidateRootPath || ""))
    fault(
      "publication-rehearsal-implicit-root-forbidden",
      "$/candidateRoot",
      "explicit absolute candidate root required",
    );
  if (
    !fs.existsSync(candidateRootPath) ||
    !fs.statSync(candidateRootPath).isDirectory()
  )
    fault(
      "publication-rehearsal-candidate-missing",
      "$/candidateRoot",
      "candidate directory required",
    );
  for (const entry of normalized.files) {
    const resolved = resolveCandidateFile(
      candidateRootPath,
      entry.path,
      `$/files/${entry.path}`,
    );
    if (
      fs.statSync(resolved).size !== entry.size ||
      fileRoot(resolved) !== entry.root
    )
      fault(
        "publication-rehearsal-file-tampered",
        `$/files/${entry.path}`,
        "candidate bytes do not match the capsule",
      );
  }
  return normalized;
}

export function resolveV4PublicationRehearsalProviderBindings({
  capsule,
  candidateRoot: candidateRootPath,
  providerBindings = capsule?.providerBindings,
}) {
  const normalized = verifyV4PublicationRehearsalCapsule({
    capsule,
    candidateRoot: candidateRootPath,
  });
  const supplied =
    validateV4PublicationRehearsalProviderBindings(providerBindings);
  if (
    releaseTailRoot(supplied) !== normalized.providerBindingsRoot ||
    JSON.stringify(supplied) !== JSON.stringify(normalized.providerBindings)
  )
    fault(
      "publication-rehearsal-provider-bindings-root-mismatch",
      "$/providerBindings",
      "external provider bindings do not match the capsule",
    );
  return {
    schema: supplied.schema,
    artifacts: Object.fromEntries(
      Object.entries(supplied.artifacts).map(([role, binding]) => [
        role,
        {
          ...binding,
          path: resolveCandidateFile(
            candidateRootPath,
            binding.path,
            `$/providerBindings/artifacts/${role}/path`,
          ),
        },
      ]),
    ),
    documents: Object.fromEntries(
      Object.entries(supplied.documents).map(([capabilityId, binding]) => [
        capabilityId,
        {
          ...binding,
          path: resolveCandidateFile(
            candidateRootPath,
            binding.path,
            `$/providerBindings/documents/${capabilityId}/path`,
          ),
        },
      ]),
    ),
    evidence: {
      inputs: supplied.evidence.inputs.map((inputPath, index) =>
        resolveCandidateFile(
          candidateRootPath,
          inputPath,
          `$/providerBindings/evidence/inputs/${index}`,
        ),
      ),
      output: resolveCandidateOutput(
        candidateRootPath,
        supplied.evidence.output,
        "$/providerBindings/evidence/output",
      ),
    },
  };
}

function simulatedAdapters(declaration, transcript) {
  const applied = new Set();
  return Object.fromEntries(
    declaration.capabilities.map((capability) => [
      capability.adapter,
      {
        async readback(effect) {
          const response = applied.has(effect.operationId)
            ? {
                outcome: "observed",
                subjectRoot: effect.subjectRoot,
                targetRoot: effect.targetRoot,
                evidenceRoots: [effect.targetRoot],
                providerCode: "simulation-observed",
              }
            : {
                outcome: "absent",
                subjectRoot: "",
                targetRoot: "",
                evidenceRoots: [],
                providerCode: "simulation-absent",
              };
          transcript.push({
            operationId: effect.operationId,
            method: "readback",
            requestRoot: effect.effectRoot,
            response,
          });
          return response;
        },
        async apply(effect) {
          applied.add(effect.operationId);
          transcript.push({
            operationId: effect.operationId,
            method: "apply",
            requestRoot: effect.effectRoot,
            response: { outcome: "simulated", code: "effect-disabled" },
          });
        },
      },
    ]),
  );
}

function observationAdapters(capsule, transcript, adapters, mode) {
  const records = new Map(
    capsule.expectedObservations.entries.map((entry) => [
      entry.operationId,
      { ...entry, index: 0 },
    ]),
  );
  return Object.fromEntries(
    capsule.declaration.capabilities.map((capability) => {
      const provided = adapters?.[capability.adapter];
      if (
        mode === "provider" &&
        (!provided ||
          typeof provided.readback !== "function" ||
          typeof provided.apply !== "function")
      )
        fault(
          "publication-rehearsal-provider-adapter-missing",
          "$/adapters",
          `adapter missing: ${capability.adapter}`,
        );
      return [
        capability.adapter,
        {
          async readback(effect) {
            const record = records.get(effect.operationId);
            const expected = record?.readbacks[record.index++];
            if (!expected)
              fault(
                "publication-rehearsal-observation-exhausted",
                "$/expectedObservations",
                `readback missing for ${effect.operationId}`,
              );
            const response =
              mode === "replay"
                ? structuredClone(expected)
                : await provided.readback(effect);
            if (JSON.stringify(response) !== JSON.stringify(expected))
              fault(
                "publication-rehearsal-provider-readback-mismatch",
                "$/expectedObservations",
                `provider readback drifted for ${effect.operationId}`,
              );
            transcript.push({
              operationId: effect.operationId,
              method: "readback",
              requestRoot: effect.effectRoot,
              response: structuredClone(response),
            });
            return response;
          },
          async apply(effect) {
            const record = records.get(effect.operationId);
            if (!record)
              fault(
                "publication-rehearsal-observation-exhausted",
                "$/expectedObservations",
                `apply missing for ${effect.operationId}`,
              );
            if (mode === "provider") await provided.apply(effect);
            transcript.push({
              operationId: effect.operationId,
              method: "apply",
              requestRoot: effect.effectRoot,
              response: structuredClone(record.apply),
            });
            if (record.apply.outcome !== "applied") {
              const error = new Error(
                "expected provider apply did not succeed",
              );
              error.releaseTailCode = record.apply.code;
              error.releaseTailClass = record.apply.classification;
              throw error;
            }
          },
        },
      ];
    }),
  );
}

export function createV4PublicationRehearsalAuthority(
  capsule,
  { authorizationRoot } = {},
) {
  const normalized = validateV4PublicationRehearsalCapsule(capsule);
  const body = {
    schema: V4_PUBLICATION_REHEARSAL_AUTHORITY_CONTRACT,
    mode: "provider-rehearsal",
    capsuleRoot: normalized.capsuleRoot,
    providerPolicyRoot: normalized.providerPolicy.root,
    providerBindingsRoot: normalized.providerBindingsRoot,
    authorizationRoot: publicationRehearsalRoot(
      authorizationRoot,
      "$/authorizationRoot",
    ),
    productionAuthority: false,
  };
  return { ...body, authorityRoot: releaseTailRoot(body) };
}

function validateAuthority(value, capsule) {
  exactKeys(
    value,
    [
      "schema",
      "mode",
      "capsuleRoot",
      "providerPolicyRoot",
      "providerBindingsRoot",
      "authorizationRoot",
      "productionAuthority",
      "authorityRoot",
    ],
    "$/authority",
  );
  const body = { ...value };
  delete body.authorityRoot;
  if (
    value.schema !== V4_PUBLICATION_REHEARSAL_AUTHORITY_CONTRACT ||
    value.mode !== "provider-rehearsal" ||
    value.productionAuthority !== false ||
    value.capsuleRoot !== capsule.capsuleRoot ||
    value.providerPolicyRoot !== capsule.providerPolicy.root ||
    value.providerBindingsRoot !== capsule.providerBindingsRoot ||
    !ROOT.test(value.authorizationRoot) ||
    value.authorityRoot !== releaseTailRoot(body)
  )
    fault(
      "publication-rehearsal-authority-mismatch",
      "$/authority",
      "exact rehearsal-only authority required",
    );
  return structuredClone(value);
}

export async function executeV4PublicationRehearsal({
  capsule,
  candidateRoot: candidateRootPath,
  mode = "simulate",
  adapters = {},
  authority = null,
  transaction = null,
  checkpoint,
} = {}) {
  if (!MODES.has(mode))
    fault(
      "invalid-publication-rehearsal-mode",
      "$/mode",
      "simulate, replay, or provider required",
    );
  const normalized = verifyV4PublicationRehearsalCapsule({
    capsule,
    candidateRoot: candidateRootPath,
  });
  const providerAuthority =
    mode === "provider" ? validateAuthority(authority, normalized) : null;
  const current = transaction
    ? structuredClone(transaction)
    : structuredClone(normalized.transaction);
  const validation = validateReleaseTailTransaction(current);
  if (
    !validation.valid ||
    current.transactionRoot !== normalized.transaction.transactionRoot ||
    current.declarationRoot !== normalized.transaction.declarationRoot ||
    current.planRoot !== normalized.transaction.planRoot
  )
    fault(
      "publication-rehearsal-transaction-mismatch",
      "$/transaction",
      "transaction is not bound to this capsule",
    );
  const transcript = [];
  const selectedAdapters =
    mode === "simulate"
      ? simulatedAdapters(normalized.declaration, transcript)
      : observationAdapters(normalized, transcript, adapters, mode);
  const result = await executeReleaseTailTransaction(current, {
    adapters: selectedAdapters,
    checkpoint,
  });
  const body = {
    schema: V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
    mode,
    truth:
      mode === "provider"
        ? "provider-observed"
        : mode === "replay"
          ? "recorded-replay"
          : "simulation-only",
    capsuleRoot: normalized.capsuleRoot,
    sourceRoot: normalized.source.root,
    candidateRoot: normalized.candidate.root,
    manifestRoot: normalized.manifest.root,
    configRoot: normalized.config.root,
    providerBindingsRoot: normalized.providerBindingsRoot,
    providerPolicyRoot: normalized.providerPolicy.root,
    expectedObservationRoot: normalized.expectedObservations.root,
    coreVersion: normalized.coreVersion,
    transactionRoot: result.transactionRoot,
    stateRoot: result.stateRoot,
    receiptRoots: result.receipts.map(({ receiptRoot }) => receiptRoot),
    transcript,
    transcriptRoot: releaseTailRoot(transcript),
    authorityRoot: providerAuthority?.authorityRoot || null,
    productionAuthority: false,
    releasePassport: null,
  };
  return {
    transaction: result,
    evidence: { ...body, evidenceRoot: releaseTailRoot(body) },
  };
}
