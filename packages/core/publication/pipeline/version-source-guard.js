import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { recordDigest } from "../../release/discussion/envelope.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fileState(cwd, file) {
  const absolute = path.join(cwd, file);
  if (fs.realpathSync(path.dirname(absolute)) !== path.dirname(absolute))
    throw new Error(
      "Version source parent directories cannot become symbolic links",
    );
  const stat = fs.lstatSync(absolute);
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(absolute))
    : stat.isFile()
      ? fs.readFileSync(absolute)
      : null;
  if (!bytes)
    throw new Error(
      "Version preparation requires regular tracked source or symbolic links",
    );
  return {
    kind: stat.isSymbolicLink() ? "link" : "file",
    executable:
      process.platform === "win32" ? null : Boolean(stat.mode & 0o111),
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function guardPipelineVersionSource(cwd, source, allowedPaths) {
  const entries = git(cwd, "ls-tree", "-r", "-z", source.commit)
    .split("\0")
    .filter(Boolean);
  const files = entries.map((entry) => {
    const match =
      /^(?:100644|100755|120000) blob [0-9a-f]{40}\t([\s\S]+)$/u.exec(entry);
    if (!match)
      throw new Error(
        "Version preparation cannot rewrite a source containing unresolved submodules",
      );
    return match[1];
  });
  const before = new Map(files.map((file) => [file, fileState(cwd, file)]));
  return () => {
    const current = git(cwd, "rev-parse", "HEAD", "HEAD^{tree}")
      .trim()
      .split(/\r?\n/u);
    if (recordDigest(current) !== recordDigest([source.commit, source.tree]))
      throw new Error(
        "Version product commands changed their admitted Git HEAD or tree",
      );
    for (const [file, expected] of before) {
      const current = fileState(cwd, file);
      if (allowedPaths.includes(file)) current.digest = expected.digest;
      if (recordDigest(current) !== recordDigest(expected))
        throw new Error(
          `Version product commands changed undeclared source bytes: ${file}`,
        );
    }
  };
}
