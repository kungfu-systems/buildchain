import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { command } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

export function bindPromotionSelection(env = process.env, run = command, emit = writeGitHubOutputs) {
  const request = JSON.parse(env.BUILDCHAIN_PROMOTION_REQUEST_JSON);
  const selection = JSON.parse(env.BUILDCHAIN_PROMOTION_SELECTION_JSON);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  for (const [directory, expected] of [["workflow-shell",selection["shell-sha"]],["runtime",selection["runtime-sha"]]]) {
    if (!/^[0-9a-f]{40}$/.test(expected || "")) throw Error("Promotion checkout requires exact SHA");
    const head=run("git",["-C",path.join(workspace,".buildchain",directory),"rev-parse","HEAD"],{stdio:"pipe"}).trim();
    if (head !== expected) throw Error(`Promotion ${directory} checkout moved`);
  }
  const source=path.join(workspace,".buildchain/source");
  const relative=request["buildchain-contract-lock-path"] || request[selection.channel === "alpha" ? "buildchain-alpha-contract-lock-path" : "buildchain-stable-contract-lock-path"];
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part=>!part || part === ".." || part === "."))
    throw Error("Selected promotion contract lock must be a repository-relative file");
  const file=fs.realpathSync(path.resolve(source,relative));
  if (!file.startsWith(fs.realpathSync(source)+path.sep) || !fs.statSync(file).isFile()) throw Error("Selected promotion contract lock escapes consumer source");
  const result={"contract-lock-path":relative,"contract-lock-digest":"sha256:"+createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
  emit(result);
  return result;
}
