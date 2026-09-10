export function selectWorkflowCallInputs(descriptor, inputs) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("controller inputs JSON must be an object");
  }
  const declaredInputs = descriptor?.inputs;
  if (
    !declaredInputs ||
    typeof declaredInputs !== "object" ||
    Array.isArray(declaredInputs)
  ) {
    throw new Error("controller descriptor inputs must be an object");
  }
  return Object.fromEntries(
    Object.entries(inputs).filter(([name]) =>
      Object.hasOwn(declaredInputs, name),
    ),
  );
}

export function resolveControllerInputBoundary(
  descriptor,
  requestedBoundary = "",
) {
  const requested = String(requestedBoundary || "").trim();
  if (requested) {
    if (!["strict", "workflow-call"].includes(requested)) {
      throw new Error(`unsupported controller input boundary: ${requested}`);
    }
    return requested;
  }

  const declaredInputs = descriptor?.inputs;
  const sources =
    declaredInputs &&
    typeof declaredInputs === "object" &&
    !Array.isArray(declaredInputs)
      ? Object.values(declaredInputs).map((entry) =>
          String(entry?.source || ""),
        )
      : [];
  return sources.length > 0 &&
    sources.every((source) =>
      ["workflow-call-input", "workflow-call-secret"].includes(source),
    )
    ? "workflow-call"
    : "strict";
}
