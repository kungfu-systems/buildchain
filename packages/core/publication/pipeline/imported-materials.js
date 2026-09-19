import { recordDigest } from "../../release/discussion/envelope.js";

export const PUBLICATION_IMPORT = "buildchain.pipeline-publication-import/v1";

export function publicationImportedValues(value) {
  const { root, ...body } = value;
  if (
    body.schema !== PUBLICATION_IMPORT ||
    root !== recordDigest(body) ||
    !Array.isArray(body.values) ||
    !body.values.length ||
    body.values.length > 1000
  )
    throw new Error(
      "Publication import is not one bounded immutable material bundle",
    );
  const ids = new Set();
  for (const item of body.values) {
    if (
      typeof item.id !== "string" ||
      !item.id.startsWith("publication/") ||
      /^publication\/(?:worker|context|recovery-import)\//u.test(item.id) ||
      ids.has(item.id) ||
      !item.id.endsWith(`/${recordDigest(item.value).slice(7)}`)
    )
      throw new Error(
        "Publication import contains duplicate, recursive or unbound materials",
      );
    ids.add(item.id);
  }
  return body.values;
}
