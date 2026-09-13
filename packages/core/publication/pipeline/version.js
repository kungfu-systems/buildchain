import { parse, stringify } from "smol-toml";
import { recordDigest } from "../../release/discussion/envelope.js";

function document(file, bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  return file.format === "json" ? JSON.parse(text) : parse(text);
}

function field(value, key) {
  const names = key.split(".");
  let parent = value;
  for (const name of names.slice(0, -1)) {
    if (
      ["__proto__", "prototype", "constructor"].includes(name) ||
      !Object.hasOwn(parent, name) ||
      !parent[name] ||
      typeof parent[name] !== "object"
    )
      throw new Error(
        "Version field does not resolve to an owned document key",
      );
    parent = parent[name];
  }
  const name = names.at(-1);
  if (
    ["__proto__", "prototype", "constructor"].includes(name) ||
    !Object.hasOwn(parent, name) ||
    typeof parent[name] !== "string"
  )
    throw new Error("Version field must be an existing string");
  return { parent, name };
}

export function readPipelineVersion(policy, files) {
  const versions = policy.files.map((file) => {
    if (!Object.hasOwn(files, file.path))
      throw new Error(`Missing declared version file: ${file.path}`);
    const { parent, name } = field(document(file, files[file.path]), file.key);
    return parent[name];
  });
  if (!versions.length || new Set(versions).size !== 1)
    throw new Error(
      "All declared version fields must identify the same candidate version",
    );
  return versions[0];
}

export function materializePipelineVersion(policy, files, version) {
  const before = readPipelineVersion(policy, files);
  if (policy.strategy === "anchored" && before !== version)
    throw new Error("Buildchain cannot rewrite anchored version authority");
  const documents = new Map();
  for (const file of policy.files) {
    if (!documents.has(file.path))
      documents.set(file.path, {
        file,
        value: document(file, files[file.path]),
      });
    const entry = documents.get(file.path);
    if (entry.file.format !== file.format)
      throw new Error("One version document cannot have conflicting formats");
    const { parent, name } = field(entry.value, file.key);
    parent[name] = version;
  }
  const changes = [...documents].flatMap(([filePath, { file, value }]) => {
    if (before === version) return [];
    const content =
      file.format === "json"
        ? `${JSON.stringify(value, null, 2)}\n`
        : stringify(value);
    return [
      {
        path: filePath,
        before: recordDigest(String(files[filePath])),
        content,
        after: recordDigest(content),
      },
    ];
  });
  return { before, version, changes };
}
