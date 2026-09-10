export function publicationAuthorityRequest(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
      value,
    ]),
  );
}
export function requireAuthorityValue(value, label) {
  if (value === undefined || value === null || value === "")
    throw new Error(`${label} is required`);
  return value;
}
