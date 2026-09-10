export function normalizeLineBootstrapRequest(value) {
  const request = typeof value === "string" ? JSON.parse(value) : value;
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Release line request must be an object");
  for (const key of ["apply", "set-default-branch", "create-alpha-pr"])
    if (typeof request[key] !== "boolean")
      throw new Error(`Release line ${key} must be boolean`);
  return {
    major: request.major,
    minor: request.minor,
    sourceRef: request["source-ref"],
    initialVersion: request["initial-version"],
    requiredStatusCheck: request["required-status-check"],
    apply: request.apply,
    setDefault: request["set-default-branch"],
    createAlphaPr: request["create-alpha-pr"],
  };
}
export function assertLineApply(apply) {
  if (apply !== true)
    throw new Error("Release line effects require apply=true");
}
