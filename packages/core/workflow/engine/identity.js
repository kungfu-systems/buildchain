import crypto from "node:crypto";
export function exactRuntime(admission) {
  const runtime = admission?.runtime;
  if (admission?.status !== "admitted") fail("Capability execution requires an admitted request");
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
