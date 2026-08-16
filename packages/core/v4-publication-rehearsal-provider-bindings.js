export class V4PublicationRehearsalFault extends Error {
  constructor(code, location, message) {
    super(`${location}: ${message}`);
    this.name = "V4PublicationRehearsalFault";
    this.code = code;
    this.location = location;
  }
}

export function publicationRehearsalFault(code, location, message) {
  throw new V4PublicationRehearsalFault(code, location, message);
}

export function publicationRehearsalExactKeys(value, expected, location) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    publicationRehearsalFault(
      "invalid-publication-rehearsal-shape",
      location,
      "object required",
    );
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    publicationRehearsalFault(
      "invalid-publication-rehearsal-shape",
      location,
      `keys must be exactly ${canonical.join(", ")}`,
    );
}

export function publicationRehearsalRoot(value, location) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    publicationRehearsalFault(
      "invalid-publication-rehearsal-root",
      location,
      "SHA-256 root required",
    );
  return value;
}

export function publicationRehearsalText(value, location) {
  if (typeof value !== "string" || value.trim() === "")
    publicationRehearsalFault(
      "invalid-publication-rehearsal-text",
      location,
      "non-empty text required",
    );
  return value.trim();
}

export function publicationRehearsalToken(value, location) {
  const normalized = publicationRehearsalText(value, location);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(normalized))
    publicationRehearsalFault(
      "invalid-publication-rehearsal-token",
      location,
      "ASCII token required",
    );
  return normalized;
}

export function publicationRehearsalRelativePath(value, location) {
  const normalized = publicationRehearsalText(value, location);
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.endsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    publicationRehearsalFault(
      "invalid-publication-rehearsal-path",
      location,
      "safe POSIX relative file path required",
    );
  return normalized;
}

export function publicationRehearsalByteSorted(
  values,
  location,
  validate = publicationRehearsalToken,
  allowEmpty = false,
) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0))
    publicationRehearsalFault(
      "invalid-publication-rehearsal-shape",
      location,
      "array required",
    );
  const normalized = values.map((value, index) =>
    validate(value, `${location}/${index}`),
  );
  const canonical = [...new Set(normalized)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (JSON.stringify(normalized) !== JSON.stringify(canonical))
    publicationRehearsalFault(
      "unordered-publication-rehearsal-values",
      location,
      "values must be unique and byte-sorted",
    );
  return normalized;
}

function canonicalObject(value, location, normalize) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    publicationRehearsalFault(
      "invalid-publication-rehearsal-shape",
      location,
      "object required",
    );
  const keys = Object.keys(value);
  const sorted = [...keys].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (JSON.stringify(keys) !== JSON.stringify(sorted))
    publicationRehearsalFault(
      "unordered-publication-rehearsal-values",
      location,
      "object keys must be byte-sorted",
    );
  return Object.fromEntries(
    keys.map((key) => [
      publicationRehearsalToken(key, `${location}/${key}`),
      normalize(value[key], key),
    ]),
  );
}

export function validateV4PublicationRehearsalProviderBindings(value) {
  publicationRehearsalExactKeys(
    value,
    ["schema", "artifacts", "documents", "evidence"],
    "$/providerBindings",
  );
  if (value.schema !== "kungfu.buildchain.release-tail.provider-bindings/v1")
    publicationRehearsalFault(
      "invalid-publication-rehearsal-provider-bindings",
      "$/providerBindings/schema",
      "unsupported provider bindings schema",
    );
  const artifacts = canonicalObject(
    value.artifacts,
    "$/providerBindings/artifacts",
    (binding, key) => {
      publicationRehearsalExactKeys(
        binding,
        ["path", "name"],
        `$/providerBindings/artifacts/${key}`,
      );
      return {
        path: publicationRehearsalRelativePath(
          binding.path,
          `$/providerBindings/artifacts/${key}/path`,
        ),
        name: publicationRehearsalText(
          binding.name,
          `$/providerBindings/artifacts/${key}/name`,
        ),
      };
    },
  );
  const documents = canonicalObject(
    value.documents,
    "$/providerBindings/documents",
    (binding, key) => {
      publicationRehearsalExactKeys(
        binding,
        ["path", "method"],
        `$/providerBindings/documents/${key}`,
      );
      if (!new Set(["PUT", "POST"]).has(binding.method))
        publicationRehearsalFault(
          "invalid-publication-rehearsal-provider-bindings",
          `$/providerBindings/documents/${key}/method`,
          "PUT or POST required",
        );
      return {
        path: publicationRehearsalRelativePath(
          binding.path,
          `$/providerBindings/documents/${key}/path`,
        ),
        method: binding.method,
      };
    },
  );
  publicationRehearsalExactKeys(
    value.evidence,
    ["inputs", "output"],
    "$/providerBindings/evidence",
  );
  return {
    schema: value.schema,
    artifacts,
    documents,
    evidence: {
      inputs: publicationRehearsalByteSorted(
        value.evidence.inputs,
        "$/providerBindings/evidence/inputs",
        publicationRehearsalRelativePath,
        true,
      ),
      output: publicationRehearsalRelativePath(
        value.evidence.output,
        "$/providerBindings/evidence/output",
      ),
    },
  };
}
