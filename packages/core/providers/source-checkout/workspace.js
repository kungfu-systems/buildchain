import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
export function resetSourceWorktree({
  workspace: requestedWorkspace,
  checkoutPath,
}) {
  const workspace = fs.realpathSync(requestedWorkspace);
  const source = path.resolve(workspace, checkoutPath);
  const relative = path.relative(workspace, source);
  requireValue(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Source reset must stay below the workspace",
  );
  const container = path.join(workspace, ".buildchain");
  requireValue(
    source !== container && !source.startsWith(container + path.sep),
    "Source reset cannot remove its metadata container",
  );
  const cache = path.join(
    container,
    `checkout-git-${crypto.createHash("sha256").update(relative).digest("hex").slice(0, 16)}`,
  );
  const sourceGit = path.join(source, ".git");
  const ancestors = [];
  for (
    let current = source;
    current !== workspace;
    current = path.dirname(current)
  )
    ancestors.push(current);
  for (const target of [...ancestors, container, cache, sourceGit]) {
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    requireValue(
      !entry || !entry.isSymbolicLink(),
      "Source reset refuses symbolic links or directory junctions",
    );
  }
  if (fs.existsSync(sourceGit) && fs.statSync(sourceGit).isDirectory()) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(container, { recursive: true });
    fs.renameSync(sourceGit, cache);
  }
  fs.rmSync(source, { recursive: true, force: true });
  if (fs.existsSync(cache) && fs.statSync(cache).isDirectory()) {
    fs.mkdirSync(source, { recursive: true });
    fs.renameSync(cache, sourceGit);
  }
}
