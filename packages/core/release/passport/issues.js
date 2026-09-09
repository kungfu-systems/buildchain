export function issue(level, code, message, details = {}) {
  return { level, code, message, details };
}
export function validateContract(value, expectedContract, label, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(
      issue("error", `${label}.object`, `${label} must be a JSON object`),
    );
    return;
  }
  if (Number(value.schemaVersion) !== 1) {
    issues.push(
      issue(
        "error",
        `${label}.schemaVersion`,
        `${label}.schemaVersion must be 1`,
      ),
    );
  }
  if (value.contract !== expectedContract) {
    issues.push(
      issue(
        "error",
        `${label}.contract`,
        `${label}.contract must be ${expectedContract}`,
      ),
    );
  }
}
