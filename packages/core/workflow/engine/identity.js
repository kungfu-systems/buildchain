import crypto from "node:crypto";
export function exactRuntime(admission) {
  const runtime = admission?.runtime;
  if (
    admission?.status !== "admitted" ||
    runtime?.repository !== "kungfu-systems/buildchain" ||
    !/^[0-9a-f]{40}$/u.test(runtime?.sha || "")
  )
    fail("an exact admitted Buildchain runtime is required");
  return runtime;
}
export function contentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(value)}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${label} has an invalid field set`);
}

export function fail(message) {
  throw new Error(message);
}
