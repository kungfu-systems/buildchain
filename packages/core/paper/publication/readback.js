import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { command, requireValue } from "../../runtime/action-process.mjs";

export function publishedPackageMatches(value, publication) {
  return (
    value?.version === publication.packageVersion &&
    value?.gitHead === publication.sourceSha &&
    typeof value?.dist?.integrity === "string" &&
    value.dist.integrity.startsWith("sha512-")
  );
}
export function resolvePublishedTag(raw, tag) {
  const values = new Map();
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    requireValue(
      [`refs/tags/${tag}`, `refs/tags/${tag}^{}`].includes(ref) &&
        /^[0-9a-f]{40}$/.test(sha) &&
        !values.has(ref),
      "Published tag lookup returned ambiguous coordinates",
    );
    values.set(ref, sha);
  }
  return (
    values.get(`refs/tags/${tag}^{}`) || values.get(`refs/tags/${tag}`) || ""
  );
}
export async function readPublishedPaper(
  publication,
  { request = fetch, execute = command, wait = setTimeout } = {},
) {
  requireValue(
    Boolean(publication.passportPath),
    "Paper publication is awaiting its generated version-state merge; merge the generated PR and rerun the failed jobs",
  );
  requireValue(
    publication.releaseTag === `v${publication.packageVersion}` &&
      /^[0-9a-f]{40}$/.test(publication.sourceSha),
    "Paper publication requires exact matching version, tag and source SHA",
  );
  let fact;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await request(
        `https://registry.npmjs.org/${encodeURIComponent(publication.packageName)}/${encodeURIComponent(publication.packageVersion)}`,
        { headers: { accept: "application/json" } },
      );
      if (response.ok) {
        const value = await response.json();
        if (publishedPackageMatches(value, publication)) {
          fact = value;
          break;
        }
      }
    } catch (error) {
      if (attempt === 5) throw error;
    }
    if (attempt < 5) await wait(5000);
  }
  requireValue(
    Boolean(fact),
    "npm publication did not become coherently readable within the bounded retry window",
  );
  const raw = execute(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${publication.releaseTag}`,
      `refs/tags/${publication.releaseTag}^{}`,
    ],
    { cwd: publication.workspace, stdio: "pipe" },
  );
  requireValue(
    resolvePublishedTag(raw, publication.releaseTag) === publication.sourceSha,
    "Published tag target does not match the exact paper source SHA",
  );
  fs.mkdirSync(path.join(publication.workspace, ".buildchain"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(publication.workspace, ".buildchain/published-package.json"),
    JSON.stringify(fact, null, 2) + "\n",
  );
  return fact;
}
