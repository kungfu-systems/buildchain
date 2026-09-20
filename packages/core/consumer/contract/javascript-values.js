export const UNKNOWN = Symbol("unresolved value"),
  TAG = Symbol("analyzer value");
export const tagged = (kind, value) => ({ [TAG]: kind, ...value });
export const namespace = (specifier) => tagged("namespace", { specifier });

// Edges cross module boundaries as data, never as interpreter objects. A
// callback or opaque runtime value requires analysis at its real call site.
export function concreteArguments(values, seen = new Set()) {
  if (values === null || values === undefined) return true;
  if (["string", "number", "boolean", "bigint"].includes(typeof values))
    return true;
  if (typeof values !== "object" || values[TAG] || seen.has(values))
    return false;
  seen.add(values);
  const result = Object.values(values).every((value) =>
    concreteArguments(value, seen),
  );
  seen.delete(values);
  return result;
}
export const processCalls = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
]);
export const inertModules = new Set([
  "fs",
  "fs/promises",
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "os",
  "util",
  "events",
  "stream",
  "zlib",
  "url",
  "path",
  "path/posix",
  "path/win32",
]);
export const inertGlobals = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Object",
  "Array",
  "JSON",
  "Math",
  "Buffer",
  "console",
  "Error",
  "TypeError",
  "RangeError",
]);
