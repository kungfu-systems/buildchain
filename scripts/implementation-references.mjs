import fs from "node:fs";

const policy = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/implementation-naming.json", import.meta.url),
    "utf8",
  ),
);

// Project frozen workflow sources through the explicit implementation relocation.
// Historical source commits and published wire identities stay unchanged.
export function rewriteImplementationReferences(source) {
  for (const [before, after] of Object.entries({
    ...policy.pathMigrations,
    ...Object.fromEntries(
      Object.entries(policy.ephemeralPathMigrations).filter(([before]) =>
        before.startsWith(".buildchain/"),
      ),
    ),
  }).sort(([a], [b]) => b.length - a.length))
    source = source.replaceAll(before, after);
  for (const [before, after] of Object.entries(policy.symbolMigrations))
    source = source.replace(new RegExp(`\\b${before}\\b`, "gu"), after);
  return source;
}
