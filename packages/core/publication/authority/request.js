export function publicationAuthorityRequest(input, selectedRuntime) {
  const request = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
      value,
    ]),
  );
  return {
    ...request,
    runtimeRepository: selectedRuntime.repository,
    runtimeSha: selectedRuntime.sha,
  };
}
export function requireAuthorityValue(value, label) {
  if (value === undefined || value === null || value === "")
    throw new Error(`${label} is required`);
  return value;
}
