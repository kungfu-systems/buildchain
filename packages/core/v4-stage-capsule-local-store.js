import fs from "node:fs";
import path from "node:path";

import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT,
  v4StageCapsuleAvailabilityRoot,
  validateV4StageCapsule,
  validateV4StageCapsuleAvailability,
} from "./v4-stage-capsule.js";
import {
  createV4StageCapsuleRetentionState,
  createV4StageCapsuleStoreReceipt,
  createV4StageCapsuleTransport,
  v4StageCapsuleBlobRoot,
  validateV4StageCapsuleOutputManifest,
} from "./v4-stage-capsule-store.js";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function fault(code, pathValue, message) {
  throw new V4ContractFault(code, pathValue, message);
}

function exactKeys(value, keys, pathValue) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-stage-capsule-store-shape", pathValue, "object required");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "invalid-stage-capsule-store-shape",
      pathValue,
      `${pathValue} keys are not canonical`,
    );
}

function token(value, pathValue) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stage-capsule-store-token",
      pathValue,
      "ASCII token required",
    );
  return value;
}

function rootedPath(rootDirectory, family, root, suffix = "") {
  validateV4Root(root);
  return path.join(
    rootDirectory,
    family,
    "sha256",
    `${root.slice("sha256:".length)}${suffix}`,
  );
}

function immutableWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o444 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!fs.readFileSync(file).equals(bytes))
      fault(
        "stage-capsule-corrupt",
        "$/store",
        "immutable location contains different bytes",
      );
    return false;
  }
}

function readBytes(file, missingCode) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT")
      fault(missingCode, "$/store", "required immutable content is absent");
    throw error;
  }
}

function readCanonicalJson(file, missingCode) {
  const bytes = readBytes(file, missingCode);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fault("stage-capsule-corrupt", "$/store", "stored JSON is invalid");
  }
  if (!v4CanonicalBytes(value).equals(bytes))
    fault("stage-capsule-corrupt", "$/store", "stored JSON is not canonical");
  return value;
}

function normalizeBlobs(manifest, blobs) {
  if (!Array.isArray(blobs))
    fault("invalid-stage-capsule-store-shape", "$/blobs", "array required");
  const byName = new Map();
  for (const [index, entry] of blobs.entries()) {
    exactKeys(entry, ["name", "bytes"], `$/blobs/${index}`);
    token(entry.name, `$/blobs/${index}/name`);
    if (byName.has(entry.name))
      fault(
        "invalid-stage-capsule-store-shape",
        `$/blobs/${index}/name`,
        "blob names must be unique",
      );
    byName.set(entry.name, Buffer.from(entry.bytes));
  }
  if (byName.size !== manifest.entries.length)
    fault("stage-capsule-partial", "$/blobs", "blob set is incomplete");
  return manifest.entries.map((entry) => {
    const bytes = byName.get(entry.name);
    if (
      !bytes ||
      bytes.length !== entry.size ||
      v4StageCapsuleBlobRoot(bytes) !== entry.root
    )
      fault(
        "stage-capsule-root-mismatch",
        `$/blobs/${entry.name}`,
        "blob bytes do not match the manifest",
      );
    return { ...entry, bytes };
  });
}

function statusForFault(code) {
  const status = code.replace(/^stage-capsule-/u, "");
  return new Set([
    "missing",
    "expired",
    "partial",
    "corrupt",
    "quarantined",
    "root-mismatch",
  ]).has(status)
    ? status
    : "corrupt";
}

export class V4StageCapsuleLocalStore {
  constructor(rootDirectory, { locatorRoot } = {}) {
    if (typeof rootDirectory !== "string" || rootDirectory.length === 0)
      fault(
        "invalid-stage-capsule-store-path",
        "$/rootDirectory",
        "path required",
      );
    this.rootDirectory = path.resolve(rootDirectory);
    this.locatorRoot =
      locatorRoot ??
      v4ContentRoot("stage-capsule-transport", {
        provider: "local-filesystem",
        mode: "local-reference",
      });
    validateV4Root(this.locatorRoot, "$/locatorRoot");
  }

  transport(observedAt) {
    return createV4StageCapsuleTransport({
      provider: "local-filesystem",
      mode: "local-reference",
      locatorRoot: this.locatorRoot,
      observedAt,
    });
  }

  paths(capsuleRoot, manifestRoot = null) {
    return {
      record: rootedPath(this.rootDirectory, "records", capsuleRoot, ".json"),
      capsule: rootedPath(this.rootDirectory, "capsules", capsuleRoot, ".json"),
      manifest: manifestRoot
        ? rootedPath(this.rootDirectory, "manifests", manifestRoot, ".json")
        : null,
      quarantine: rootedPath(
        this.rootDirectory,
        "quarantine",
        capsuleRoot,
        ".json",
      ),
    };
  }

  put({ capsule, manifest, blobs, recordedAt }) {
    validateV4StageCapsule(capsule);
    validateV4StageCapsuleOutputManifest(manifest);
    validateV4Clock(recordedAt, "$/recordedAt");
    if (manifest.manifestRoot !== capsule.identity.outputManifestRoot)
      fault(
        "stage-capsule-root-mismatch",
        "$/manifest/manifestRoot",
        "capsule does not bind the stored manifest",
      );
    const content = normalizeBlobs(manifest, blobs);
    const retention = createV4StageCapsuleRetentionState({
      capsule,
      evaluatedAt: recordedAt,
    });
    if (retention.status === "expired")
      fault("stage-capsule-expired", "$/recordedAt", "retention expired");
    let wrote = false;
    for (const entry of content)
      wrote =
        immutableWrite(
          rootedPath(this.rootDirectory, "blobs", entry.root),
          entry.bytes,
        ) || wrote;
    const files = this.paths(capsule.capsuleRoot, manifest.manifestRoot);
    wrote = immutableWrite(files.manifest, v4CanonicalBytes(manifest)) || wrote;
    wrote = immutableWrite(files.capsule, v4CanonicalBytes(capsule)) || wrote;
    const record = {
      schema: "buildchain-v4-stage-capsule-store-record/v1",
      capsuleRoot: capsule.capsuleRoot,
      manifestRoot: manifest.manifestRoot,
    };
    wrote = immutableWrite(files.record, v4CanonicalBytes(record)) || wrote;
    const located = this.locate({
      capsuleRoot: capsule.capsuleRoot,
      recordedAt,
    });
    return createV4StageCapsuleStoreReceipt({
      ...located.receipt,
      operation: "put",
      outcome: wrote ? "stored" : "already-stored",
      recordedAt,
    });
  }

  verifyStored(capsuleRoot, evaluatedAt, { skipQuarantine = false } = {}) {
    validateV4Root(capsuleRoot, "$/capsuleRoot");
    validateV4Clock(evaluatedAt, "$/evaluatedAt");
    const base = this.paths(capsuleRoot);
    if (!skipQuarantine && fs.existsSync(base.quarantine))
      fault("stage-capsule-quarantined", "$/store", "capsule is quarantined");
    const record = readCanonicalJson(base.record, "stage-capsule-missing");
    exactKeys(record, ["schema", "capsuleRoot", "manifestRoot"], "$/record");
    if (
      record.schema !== "buildchain-v4-stage-capsule-store-record/v1" ||
      record.capsuleRoot !== capsuleRoot
    )
      fault("stage-capsule-root-mismatch", "$/record", "record root mismatch");
    validateV4Root(record.manifestRoot, "$/record/manifestRoot");
    const files = this.paths(capsuleRoot, record.manifestRoot);
    const capsule = readCanonicalJson(files.capsule, "stage-capsule-partial");
    validateV4StageCapsule(capsule);
    if (capsule.capsuleRoot !== capsuleRoot)
      fault(
        "stage-capsule-root-mismatch",
        "$/capsule/capsuleRoot",
        "stored capsule root mismatch",
      );
    const manifest = readCanonicalJson(files.manifest, "stage-capsule-partial");
    validateV4StageCapsuleOutputManifest(manifest);
    if (
      manifest.manifestRoot !== record.manifestRoot ||
      manifest.manifestRoot !== capsule.identity.outputManifestRoot
    )
      fault(
        "stage-capsule-root-mismatch",
        "$/manifest/manifestRoot",
        "stored manifest root mismatch",
      );
    const retention = createV4StageCapsuleRetentionState({
      capsule,
      evaluatedAt,
    });
    if (retention.status === "expired")
      fault("stage-capsule-expired", "$/evaluatedAt", "retention expired");
    const blobs = manifest.entries.map((entry) => {
      const bytes = readBytes(
        rootedPath(this.rootDirectory, "blobs", entry.root),
        "stage-capsule-partial",
      );
      if (
        bytes.length !== entry.size ||
        v4StageCapsuleBlobRoot(bytes) !== entry.root
      )
        fault(
          "stage-capsule-corrupt",
          `$/blobs/${entry.name}`,
          "stored blob root mismatch",
        );
      return { name: entry.name, root: entry.root, bytes };
    });
    return { capsule, manifest, retention, blobs };
  }

  observe({ capsuleRoot, observedAt }) {
    const transport = this.transport(observedAt);
    try {
      const stored = this.verifyStored(capsuleRoot, observedAt);
      return {
        stored,
        transport,
        availability: validateV4StageCapsuleAvailability({
          schema: V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT,
          capsuleRoot,
          observedAt,
          status: "available",
          contentRoot: stored.manifest.manifestRoot,
          qualificationRoot: stored.capsule.identity.qualificationRoot,
          transports: [
            { name: "local-reference", root: transport.transportRoot },
          ],
          faultCode: null,
        }),
      };
    } catch (error) {
      if (!(error instanceof V4ContractFault)) throw error;
      return {
        stored: null,
        transport,
        availability: validateV4StageCapsuleAvailability({
          schema: V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT,
          capsuleRoot,
          observedAt,
          status: statusForFault(error.code),
          contentRoot: null,
          qualificationRoot: null,
          transports: [
            { name: "local-reference", root: transport.transportRoot },
          ],
          faultCode: token(error.code, "$/availability/faultCode"),
        }),
      };
    }
  }

  locate({ capsuleRoot, recordedAt }) {
    const observation = this.observe({ capsuleRoot, observedAt: recordedAt });
    if (observation.availability.status !== "available")
      fault(
        observation.availability.faultCode,
        "$/store",
        `capsule locate failed: ${observation.availability.status}`,
      );
    const { stored, transport, availability } = observation;
    return {
      ...observation,
      receipt: createV4StageCapsuleStoreReceipt({
        operation: "locate",
        recordedAt,
        capsuleRoot,
        manifestRoot: stored.manifest.manifestRoot,
        retentionStateRoot: stored.retention.stateRoot,
        availabilityRoot: v4StageCapsuleAvailabilityRoot(availability),
        transportRoot: transport.transportRoot,
        qualificationRoot: stored.capsule.identity.qualificationRoot,
        outcome: "located",
        faultCode: null,
      }),
    };
  }

  restore({ capsuleRoot, recordedAt }) {
    const located = this.locate({ capsuleRoot, recordedAt });
    return {
      capsule: located.stored.capsule,
      manifest: located.stored.manifest,
      blobs: located.stored.blobs,
      availability: located.availability,
      receipt: createV4StageCapsuleStoreReceipt({
        ...located.receipt,
        operation: "restore",
        outcome: "restored",
        recordedAt,
      }),
    };
  }

  quarantine({ capsuleRoot, recordedAt, reason }) {
    const stored = this.verifyStored(capsuleRoot, recordedAt, {
      skipQuarantine: true,
    });
    token(reason, "$/reason");
    const markerBody = {
      schema: "buildchain-v4-stage-capsule-quarantine/v1",
      capsuleRoot,
      recordedAt,
      reason,
    };
    immutableWrite(
      this.paths(capsuleRoot).quarantine,
      v4CanonicalBytes({
        ...markerBody,
        markerRoot: v4ContentRoot("stage-capsule-quarantine", markerBody),
      }),
    );
    const transport = this.transport(recordedAt);
    const availability = validateV4StageCapsuleAvailability({
      schema: V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT,
      capsuleRoot,
      observedAt: recordedAt,
      status: "quarantined",
      contentRoot: null,
      qualificationRoot: null,
      transports: [{ name: "local-reference", root: transport.transportRoot }],
      faultCode: "stage-capsule-quarantined",
    });
    return createV4StageCapsuleStoreReceipt({
      operation: "quarantine",
      recordedAt,
      capsuleRoot,
      manifestRoot: stored.manifest.manifestRoot,
      retentionStateRoot: stored.retention.stateRoot,
      availabilityRoot: v4StageCapsuleAvailabilityRoot(availability),
      transportRoot: transport.transportRoot,
      qualificationRoot: stored.capsule.identity.qualificationRoot,
      outcome: "quarantined",
      faultCode: null,
    });
  }
}
