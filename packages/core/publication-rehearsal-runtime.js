import fs from "node:fs";
import path from "node:path";

import { releaseTailRoot } from "./release-tail-provider-plane.js";
import {
  V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
  createV4PublicationRehearsalCapsule,
  executeV4PublicationRehearsal,
  validateV4PublicationRehearsalCapsule,
  verifyV4PublicationRehearsalCapsule,
} from "./v4-publication-rehearsal.js";

export const PUBLICATION_REHEARSAL_CAPSULE_CONTRACT =
  V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT;
export const PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT =
  V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT;
export const PUBLICATION_REHEARSAL_DIAGNOSTIC_CONTRACT =
  "buildchain-v4-publication-rehearsal-compatibility-diagnostic/v1";
export const RELEASE_LOCAL_CONSTRUCTIBILITY_ADR =
  "docs/v4-publication-rehearsal.md";
export const RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT =
  "Publication rehearsal is source-, candidate-, manifest-, config-, policy-, observation-, and shared-core-bound; rehearsal authority is effect-disabled by default and never grants production authority.";
export const PUBLICATION_REHEARSAL_COMMAND =
  'buildchain release-tail rehearse --capsule "$PWD/.buildchain/publication-rehearsal/capsule.json" --candidate-root "$PWD/.buildchain/publication-rehearsal/candidate" --mode simulate --state "$PWD/.buildchain/publication-rehearsal/state.json" --evidence "$PWD/.buildchain/publication-rehearsal/evidence.json"';

const REQUIRED_V4_INPUTS = Object.freeze([
  "source.repository",
  "source.revision",
  "manifest.path",
  "manifest.root",
  "config.path",
  "config.root",
]);

function migrationReceipt(surface, reasonCode) {
  const body = {
    schema: "buildchain-v3-v4-public-surface-migration/v1",
    surface,
    status: "migration-required",
    reasonCode,
    replacement: {
      module: "@kungfu-tech/buildchain/v4-publication-rehearsal",
      capsuleContract: V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
      requiredInputs: REQUIRED_V4_INPUTS,
    },
    productionAuthority: false,
  };
  return { ...body, migrationRoot: releaseTailRoot(body) };
}

export class PublicationRehearsalError extends Error {
  constructor(
    message,
    {
      code = "publication-rehearsal-v4-migration-required",
      classification = "migration",
      migration = null,
      cause,
    } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "PublicationRehearsalError";
    this.rehearsalCode = code;
    this.rehearsalClass = classification;
    this.migration = migration;
    this.bindingRoot = "";
  }
}

function hasV4CreationBindings(input) {
  return Boolean(
    input?.source?.repository &&
    input?.source?.revision &&
    input?.manifest?.path &&
    input?.manifest?.root &&
    input?.config?.path &&
    input?.config?.root,
  );
}

function requireV4CreationBindings(input, surface) {
  if (hasV4CreationBindings(input)) return;
  const migration = migrationReceipt(surface, "v4-source-binding-required");
  throw new PublicationRehearsalError(
    "v3 rehearsal capsules cannot be upgraded implicitly; provide the v4 source, manifest, and config bindings",
    { migration },
  );
}

export function createPublicationRehearsalCapsule(input = {}) {
  requireV4CreationBindings(
    input,
    "@kungfu-tech/buildchain/publication-rehearsal-runtime#createPublicationRehearsalCapsule",
  );
  return createV4PublicationRehearsalCapsule(input);
}

export function normalizePublicationRehearsalCapsule(input) {
  return validateV4PublicationRehearsalCapsule(input);
}

export function verifyPublicationRehearsalCapsule({
  capsule,
  capsuleRoot,
  candidateRoot = capsuleRoot,
} = {}) {
  return verifyV4PublicationRehearsalCapsule({ capsule, candidateRoot });
}

export function publicationRehearsalBindingRoot(capsule) {
  return validateV4PublicationRehearsalCapsule(capsule).capsuleRoot;
}

export function publicationRehearsalDiagnostic(error, { capsule } = {}) {
  const migration = error?.migration || null;
  const body = {
    contract: PUBLICATION_REHEARSAL_DIAGNOSTIC_CONTRACT,
    status: "rejected",
    errorClass: error?.rehearsalClass || (migration ? "migration" : "input"),
    code:
      error?.rehearsalCode ||
      error?.code ||
      "publication-rehearsal-runtime-error",
    message: String(error?.message || "publication rehearsal failed"),
    bindingRoot: capsule?.capsuleRoot || "",
    migration,
    productionAuthority: false,
  };
  return { ...body, diagnosticRoot: releaseTailRoot(body) };
}

export async function executePublicationRehearsal({
  capsule,
  capsuleRoot,
  candidateRoot = capsuleRoot,
  mode = "simulate",
  environment = {},
  adapters = {},
  authority = null,
  transaction = null,
  checkpoint,
} = {}) {
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.keys(environment).length > 0
  ) {
    const migration = migrationReceipt(
      "@kungfu-tech/buildchain/publication-rehearsal-runtime#executePublicationRehearsal",
      "ambient-environment-forbidden",
    );
    throw new PublicationRehearsalError(
      "v4 rehearsal accepts no ambient environment; bind every semantic input into the capsule",
      { code: "undeclared-environment", classification: "input", migration },
    );
  }
  return executeV4PublicationRehearsal({
    capsule,
    candidateRoot,
    mode,
    adapters,
    authority,
    transaction,
    checkpoint,
  });
}

export function resolvePublicationRehearsalFile(capsuleRoot, relativePath) {
  if (!path.isAbsolute(capsuleRoot))
    throw new PublicationRehearsalError(
      "capsuleRoot must be an explicit absolute path",
      { code: "implicit-workspace-forbidden", classification: "input" },
    );
  const base = fs.realpathSync(capsuleRoot);
  const resolved = path.resolve(base, String(relativePath || ""));
  if (
    !resolved.startsWith(`${base}${path.sep}`) ||
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isFile() ||
    fs.lstatSync(resolved).isSymbolicLink() ||
    !fs.realpathSync(resolved).startsWith(`${base}${path.sep}`)
  )
    throw new PublicationRehearsalError(
      "publication rehearsal file must be a regular file inside the explicit candidate root",
      { code: "capsule-path-ambiguous", classification: "input" },
    );
  return resolved;
}
