import YAML from "yaml";

// actionlint 1.7.12 predates GitHub's self-repository action references.
// Resolve only this syntax in the isolated source project so actionlint still
// validates the real action's inputs, outputs and every other expression.
export function lowerSelfReferencesForLint(source) {
  const document = YAML.parseDocument(source);
  if (document.errors.length) throw document.errors[0];
  YAML.visit(document, {
    Pair(_key, pair) {
      if (pair.key?.value !== "uses" || typeof pair.value?.value !== "string") return;
      const reference = pair.value.value;
      if (!reference.startsWith("$/")) return;
      if (!/^\$\/actions\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/u.test(reference))
        throw new Error(`Invalid Buildchain self action reference: ${reference}`);
      pair.value.value = `.${reference.slice(1)}`;
    },
  });
  return String(document);
}
