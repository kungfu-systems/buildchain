import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const MAX_BUNDLE_MEMBER_BYTES = 8 * 1024 * 1024;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function stableJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, canonical(item[key])]),
    );
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function readRegular(filePath, label, maximumBytes = 8 * 1024 * 1024) {
  const metadata = fs.lstatSync(filePath);
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `${label} must be a regular non-symlink file`,
  );
  invariant(
    metadata.size <= maximumBytes,
    `${label} exceeds ${maximumBytes} bytes`,
  );
  return fs.readFileSync(filePath);
}

export function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

export function readJson(filePath, label) {
  try {
    return JSON.parse(decodeUtf8(readRegular(filePath, label), label));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`${label} must be valid JSON`);
    throw error;
  }
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, stableJson(value));
}

export function resolveInside(root, relativePath, label) {
  invariant(
    typeof relativePath === "string" && relativePath.length > 0,
    `${label} is required`,
  );
  invariant(
    !path.isAbsolute(relativePath),
    `${label} must be repository-relative`,
  );
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, resolved);
  invariant(
    relation && !relation.startsWith("..") && !path.isAbsolute(relation),
    `${label} escapes its root`,
  );
  return resolved;
}

export function ensureEmptyDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true });
  const metadata = fs.lstatSync(directory);
  invariant(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    `${label} must be a non-symlink directory`,
  );
  invariant(
    fs.readdirSync(directory).length === 0,
    `${label} must be initially empty`,
  );
}

export function listFiles(root, prefix = "") {
  const directory = path.join(root, prefix);
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    invariant(
      !entry.isSymbolicLink(),
      `bundle member must not be a symlink: ${path.join(prefix, entry.name)}`,
    );
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else {
      invariant(
        entry.isFile(),
        `bundle member must be a regular file: ${relative}`,
      );
      files.push(relative.split(path.sep).join("/"));
    }
  }
  return files;
}

export function writeChecksums(root, checksumName = "checksums.sha256") {
  const names = listFiles(root).filter((name) => name !== checksumName);
  const rows = names.map(
    (name) =>
      `${sha256(fs.readFileSync(path.join(root, name))).slice(7)}  ${name}`,
  );
  const bytes = `${rows.join("\n")}\n`;
  fs.writeFileSync(path.join(root, checksumName), bytes);
  return sha256(Buffer.from(bytes));
}

export function verifyChecksums(
  root,
  checksumName = "checksums.sha256",
  options = {},
) {
  const bytes = readRegular(path.join(root, checksumName), checksumName);
  const text = decodeUtf8(bytes, checksumName);
  invariant(text.endsWith("\n"), `${checksumName} must end with a newline`);
  const rows = text.slice(0, -1).split("\n").filter(Boolean);
  const declared = new Set();
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  ([^\0\r\n]+)$/.exec(row);
    invariant(match, `invalid checksum row: ${row}`);
    const member = match[2];
    const target = resolveInside(root, member, "checksum member");
    invariant(!declared.has(member), `duplicate checksum member: ${member}`);
    declared.add(member);
    const maximumBytes =
      options.allowLongFormRendererManifest && member === "manifest.json"
        ? 32 * 1024 * 1024
        : MAX_BUNDLE_MEMBER_BYTES;
    invariant(
      sha256(readRegular(target, member, maximumBytes)).slice(7) === match[1],
      `checksum mismatch: ${member}`,
    );
  }
  const actual = listFiles(root).filter((name) => name !== checksumName);
  invariant(
    actual.length === declared.size &&
      actual.every((name) => declared.has(name)),
    `${checksumName} must cover every bundle member exactly once`,
  );
  return sha256(bytes);
}

export function exactKeys(value, required, optional, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    invariant(allowed.has(key), `${label}.${key} is not declared`);
  for (const key of required)
    invariant(key in value, `${label}.${key} is required`);
}

export function integer(value, minimum, maximum, label) {
  invariant(
    Number.isInteger(value) && value >= minimum && value <= maximum,
    `${label} is out of range`,
  );
  return value;
}

export function text(value, minimum, maximum, label) {
  invariant(
    typeof value === "string" &&
      value.length >= minimum &&
      value.length <= maximum,
    `${label} is invalid`,
  );
  return value;
}

export function required(values, key) {
  invariant(values[key], `${key} is required`);
  return values[key];
}

export function appendOutputs(outputPath, entries) {
  if (!outputPath) return;
  const rows = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputPath, `${rows.join("\n")}\n`);
}

export function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function semanticRoot(value) {
  return sha256(Buffer.from(stableJson(value)));
}
