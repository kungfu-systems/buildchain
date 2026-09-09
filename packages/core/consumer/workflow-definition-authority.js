import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { SOURCE_OWNED_PROMOTION } from "./invocation-selector.js";
export { SOURCE_OWNED_PROMOTION };

export function verifyWorkflowDefinition({
  root,
  repository,
  definitionRepository,
  definitionSha,
  workflowSha,
  files,
}) {
  if (
    repository !== SOURCE_OWNED_PROMOTION.repository ||
    definitionRepository !== repository
  )
    throw new Error(
      "Source-owned invocation requires the defining Buildchain repository",
    );
  if (
    !/^[0-9a-f]{40}$/.test(definitionSha || "") ||
    definitionSha !== workflowSha
  )
    throw new Error(
      "Source-owned invocation must use the exact defining workflow commit",
    );
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (git("rev-parse", "HEAD").toString().trim() !== definitionSha)
    throw new Error(
      "Invocation checkout does not match its defining workflow commit",
    );
  for (const { path: relative } of files) {
    const absolute = path.resolve(root, relative);
    if (
      !absolute.startsWith(`${path.resolve(root)}${path.sep}`) ||
      fs.lstatSync(absolute).isSymbolicLink()
    )
      throw new Error(
        "Invocation source must be a repository-owned regular file",
      );
    let committed;
    try {
      committed = git("show", `${definitionSha}:${relative}`);
    } catch {
      throw new Error(`Invocation source is not committed: ${relative}`);
    }
    if (!committed.equals(fs.readFileSync(absolute)))
      throw new Error(
        `Invocation source differs from its defining commit: ${relative}`,
      );
  }
  return {
    repository,
    commitSha: definitionSha,
    filesRoot: `sha256:${crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex")}`,
  };
}
