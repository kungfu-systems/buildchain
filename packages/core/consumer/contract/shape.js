// Closed data validation shared by TOML, event identities and managed locks.
export function object(value, required, optional = [], location = "config") {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`${location}: expected a table`);
  for (const key of Object.keys(value))
    if (![...required, ...optional].includes(key))
      throw new Error(`${location}.${key}: unknown field`);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new Error(`${location}.${key}: required field`);
  return value;
}

export function text(value, location, pattern = /\S/u) {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("\0"))
    throw new Error(`${location}: invalid string`);
  return value;
}

export function choice(value, choices, location) {
  if (!choices.includes(value))
    throw new Error(`${location}: expected ${choices.join(" or ")}`);
  return value;
}

export function list(value, location, validate) {
  if (!Array.isArray(value) || !value.length)
    throw new Error(`${location}: expected a nonempty list`);
  return value.map((item, index) => validate(item, `${location}[${index}]`));
}

export function unique(values, location) {
  if (new Set(values).size !== values.length)
    throw new Error(`${location}: duplicate identity`);
}

export function relativePath(value, location) {
  text(value, location, /^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$/u);
  if (value.split("/").some((part) => !part || part === ".." || part === "."))
    throw new Error(`${location}: expected a repository-relative path`);
  return value;
}

export function slug(value, location) {
  return text(value, location, /^[a-z][a-z0-9-]*$/u);
}
