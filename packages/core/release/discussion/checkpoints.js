import {
  retainAttachment,
  diagnosticReport,
  diagnosticLog,
} from "./evidence.js";
import fs from "node:fs";
import path from "node:path";
import { createProgress, recordDigest } from "./envelope.js";
import { materialDigest } from "../../providers/github/discussions/materials.js";
import { discussionMaterials } from "../../providers/github/discussions/materials.js";

export function releaseCheckpoints({ session, store, octokit }) {
  const materials = discussionMaterials({
    octokit,
    repository: session.intent.repository,
    intentId: session.intent.id,
  });
  async function checkpoint(
    node,
    value,
    { attachments = [], label = value.schema || "Recovery checkpoint" } = {},
  ) {
    const observed = await store.read(session);
    const records = observed.records.filter(
      (record) =>
        record.kind === "checkpoint" &&
        record.attempt === session.attempt &&
        record.node === node,
    );
    const root = recordDigest(value);
    const duplicate = records.find((record) => record.payload.root === root);
    if (duplicate) return duplicate;
    const sequence =
      Math.max(-1, ...records.map((record) => record.sequence)) + 1;
    const handle = await retainAttachment(materials, {
      name: `${node}-checkpoint-${sequence}.json`,
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(value, null, 2) + "\n"),
    });
    const record = createProgress({
      intent: session.intent,
      runtime: session.runtime,
      attempt: session.attempt,
      writer: session.writer || session.attempt,
      predecessor: session.predecessor,
      kind: "checkpoint",
      node,
      status: "running",
      sequence,
      payload: {
        schema: "buildchain.release-checkpoint/v1",
        root,
        material: handle,
        label,
        attachments: [handle, ...attachments],
      },
    });
    await store.append(session, record);
    return record;
  }
  async function readCheckpoint(record) {
    if (
      record.kind !== "checkpoint" ||
      record.payload?.schema !== "buildchain.release-checkpoint/v1"
    )
      throw new Error("Unsupported recovery checkpoint");
    const value = JSON.parse(await materials.read(record.payload.material));
    if (recordDigest(value) !== record.payload.root)
      throw new Error("Recovery checkpoint root differs from its record");
    return value;
  }
  async function publicationReader(currentBytes) {
    const observed = await store.read(session);
    const first = observed.records
      .filter(
        (record) =>
          record.kind === "checkpoint" && record.node === "qualification",
      )
      .sort(
        (a, b) =>
          observed.attempts.indexOf(a.attempt) -
            observed.attempts.indexOf(b.attempt) || a.sequence - b.sequence,
      )[0];
    if (!first) return currentBytes;
    const manifest = await readCheckpoint(first);
    if (manifest.schema !== "buildchain.release-recovery-material/v1")
      throw new Error("Unsupported retained publication reader manifest");
    return materials.read(manifest.reader);
  }
  async function diagnostics(node, code) {
    const report = diagnosticReport(
      session,
      await store.read(session),
      node,
      code,
    );
    const log = await retainAttachment(materials, {
      name: `${node}-diagnostics.log`,
      mediaType: "text/plain",
      bytes: diagnosticLog(report),
    });
    return checkpoint(node, report, {
      attachments: [log],
      label: `Execution diagnostics: ${report.code}`,
    });
  }
  return {
    checkpoint,
    readCheckpoint,
    materials,
    publicationReader,
    diagnostics,
  };
}

function assertNoSymlink(file, base) {
  let current = file;
  while (current.startsWith(base)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("Recovery path contains a symbolic link");
    if (current === base) break;
    current = path.dirname(current);
  }
}

const MATERIAL_INPUTS = [
  "candidate-passport-path",
  "candidate-build-summary-path",
  "stage-capsules-path",
  "product-publication-intent-path",
  "publication-qualification-path",
  "required-artifacts-path",
  "sealed-bundle-manifest",
  "recovery-receipt-path",
];

export async function retainRecoveryMaterials(
  { request, workspace, readerFile },
  materials,
) {
  const base = path.resolve(workspace);
  const files = new Set(
    MATERIAL_INPUTS.map((name) => request[name])
      .filter(Boolean)
      .map((file) => path.resolve(base, file)),
  );
  for (const file of request["artifact-paths"] || [])
    files.add(path.resolve(base, file));
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Recovery materials must not contain symbolic links");
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.add(file);
      if (files.size > 512)
        throw new Error("Recovery material file count exceeded");
    }
  };
  if (request["sealed-bundle-root"]) {
    const root = path.resolve(base, request["sealed-bundle-root"]);
    if (!root.startsWith(path.join(base, ".buildchain") + path.sep))
      throw new Error("Sealed recovery directory is outside consumer evidence");
    assertNoSymlink(root, base);
    walk(root);
  }
  const handles = [];
  let totalSize = 0;
  for (const file of files) {
    const relative = path.relative(base, file).split(path.sep).join("/");
    if (
      !relative.startsWith(".buildchain/") ||
      relative.startsWith(".buildchain/runtime/") ||
      relative.includes("../")
    )
      throw new Error(
        "Recovery materials must remain in the declared consumer evidence directory",
      );
    assertNoSymlink(file, base);
    const info = fs.lstatSync(file);
    if (!info.isFile())
      throw new Error("Recovery material is not a regular file");
    totalSize += info.size;
    if (totalSize > 1024 * 1024 * 1024)
      throw new Error("Recovery material byte budget exceeded");
    handles.push({
      path: relative,
      ...(await materials.put(fs.readFileSync(file))),
    });
  }
  return {
    schema: "buildchain.release-recovery-material/v1",
    source: {
      repository: request.repository,
      sourceSha: request["source-sha"],
      version: request.version,
      targetRef: request["target-ref"],
      channel: request.channel,
    },
    releaseAssets: (request["artifact-paths"] || []).map((file) =>
      path.relative(base, path.resolve(base, file)).split(path.sep).join("/"),
    ),
    files: handles,
    inputs: Object.fromEntries(
      [...MATERIAL_INPUTS, "sealed-bundle-root"].map((key) => [
        key,
        request[key]
          ? path
              .relative(base, path.resolve(base, request[key]))
              .split(path.sep)
              .join("/")
          : "",
      ]),
    ),
    reader: await materials.put(fs.readFileSync(readerFile)),
  };
}

function recoveryInventory(manifest, directory) {
  if (
    manifest.schema !== "buildchain.release-recovery-material/v1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 512
  )
    throw new Error("Unsupported recovery material manifest");
  const base = path.resolve(directory),
    paths = new Set();
  const files = manifest.files.map((handle) => {
    if (
      typeof handle.path !== "string" ||
      !handle.path.startsWith(".buildchain/") ||
      handle.path.startsWith(".buildchain/runtime/") ||
      handle.path
        .split(/[\\/]/u)
        .some((part) => ["..", ".", ""].includes(part)) ||
      paths.has(handle.path)
    )
      throw new Error("Unsafe recovery material path");
    paths.add(handle.path);
    const file = path.resolve(base, handle.path);
    assertNoSymlink(file, base);
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() ||
        materialDigest(fs.readFileSync(file)) !== handle.digest)
    )
      throw new Error(
        "Recovery material destination already exists with different bytes",
      );
    return { handle, file };
  });
  const inputs = Object.fromEntries(
    Object.entries(manifest.inputs).map(([key, relative]) => {
      if (!relative) return [key, ""];
      const present =
        key === "sealed-bundle-root"
          ? [...paths].some((file) => file.startsWith(relative + "/"))
          : paths.has(relative);
      if (!present)
        throw new Error("Recovery input is outside the retained inventory");
      return [key, path.resolve(base, relative)];
    }),
  );
  if ((manifest.releaseAssets || []).some((file) => !paths.has(file)))
    throw new Error("Release asset is outside the retained inventory");
  return { files, inputs };
}

export async function restoreRecoveryMaterials(manifest, directory, materials) {
  const { files, inputs } = recoveryInventory(manifest, directory);
  let total = 0;
  for (const { handle, file } of files) {
    total += handle.size || 0;
    if (total > 1024 * 1024 * 1024)
      throw new Error("Recovery material byte budget exceeded");
    const bytes = await materials.read(handle);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: "wx" });
  }
  return inputs;
}
