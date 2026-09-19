import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  inspectPipelineSource,
  buildPipelineProducts,
} from "../../workflow/pipeline/build.js";
import { verifyPipelineVersionPreparation } from "./version-preparation.js";
import { guardPipelineVersionSource } from "./version-source-guard.js";
import { materializePipelineVersion } from "./version.js";
import {
  pipelineVersionMaterialPaths,
  pipelineVersionRegenerationResult,
  collectPipelineVersionMaterial,
} from "./version-regeneration.js";

function materialFiles(cwd, paths) {
  return Object.fromEntries(
    paths.map((file) => {
      const absolute = path.resolve(cwd, file);
      const stat = fs.lstatSync(absolute);
      if (
        !stat.isFile() ||
        stat.size > 4 * 1024 * 1024 ||
        fs.realpathSync(absolute) !== absolute
      )
        throw new Error(
          "Version preparation requires bounded regular source files without symlinks",
        );
      const bytes = fs.readFileSync(absolute);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content).equals(bytes))
        throw new Error("Version preparation cannot rewrite non-UTF8 material");
      return [file, content];
    }),
  );
}

function trackedModes(cwd, paths) {
  const entries = execFileSync(
    "git",
    ["-C", cwd, "ls-files", "--stage", "-z", "--", ...paths],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const modes = Object.fromEntries(
    entries.map((entry) => {
      const match = /^(100644|100755) [0-9a-f]{40} 0\t(.+)$/u.exec(entry);
      if (!match)
        throw new Error("Version preparation requires tracked regular files");
      return [match[2], match[1]];
    }),
  );
  if (recordDigest(Object.keys(modes).sort()) !== recordDigest(paths))
    throw new Error(
      "Version preparation material is absent from the source tree",
    );
  return modes;
}

function assertPreparedDiff(cwd, paths, modes) {
  const changes = execFileSync(
    "git",
    ["-C", cwd, "diff", "HEAD", "--name-status", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (let index = 0; index < changes.length; index += 2)
    if (changes[index] !== "M" || !paths.includes(changes[index + 1]))
      throw new Error(
        "Version product commands changed undeclared source paths",
      );
  if (recordDigest(trackedModes(cwd, paths)) !== recordDigest(modes))
    throw new Error("Version product commands changed tracked file modes");
  const raw = execFileSync("git", ["-C", cwd, "diff", "HEAD", "--summary"], {
    encoding: "utf8",
  });
  if (raw.trim())
    throw new Error(
      "Version product commands changed source file kinds or modes",
    );
}

export async function buildPipelineVersionMaterial({
  cwd,
  preparation,
  platform,
  environment = process.env,
}) {
  cwd = fs.realpathSync(cwd);
  const contract = inspectPipelineSource(cwd, preparation.source);
  verifyPipelineVersionPreparation(preparation, contract);
  if (environment.BUILDCHAIN_RUNTIME_SHA !== preparation.runtime.sha)
    throw new Error(
      "Version preparation is not using its admitted execution runtime",
    );
  const paths = pipelineVersionMaterialPaths(
    preparation.versionPolicy,
    preparation.source.configPath,
  );
  const modes = trackedModes(cwd, paths);
  const guard = guardPipelineVersionSource(cwd, preparation.source, paths);
  const before = materialFiles(cwd, paths);
  const material = materializePipelineVersion(
    preparation.versionPolicy,
    before,
    preparation.version,
  );
  // Product code runs only in this credentialless job. The provider writer
  // independently observes job completion and verifies these exact bytes.
  for (const { path: file, content } of material.changes)
    fs.writeFileSync(path.join(cwd, file), content);
  await buildPipelineProducts({ cwd, plan: contract, platform, environment });
  guard();
  assertPreparedDiff(cwd, paths, modes);
  const result = pipelineVersionRegenerationResult(
    preparation,
    platform,
    materialFiles(cwd, paths),
  );
  collectPipelineVersionMaterial(
    { ...preparation, platforms: [platform] },
    before,
    [result],
  );
  return result;
}
