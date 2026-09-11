import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { command } from "../../runtime/action-process.mjs";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";

export function bindPromotionSelection(
  { request, selection, workspace, sourceSha },
  run = command,
) {
  for (const [directory, expected] of [
    ["source", sourceSha],
  ]) {
    verifyCheckoutIdentity(
      {
        directory: path.join(workspace, ".buildchain", directory),
        sha: expected,
        label: `Promotion ${directory}`,
      },
      run,
    );
  }
  const source = path.join(workspace, ".buildchain/source");
  const relative = selection["contract-lock-path"];
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === ".." || part === ".")
  )
    throw Error(
      "Selected promotion contract lock must be a repository-relative file",
    );
  const file = fs.realpathSync(path.resolve(source, relative));
  if (
    !file.startsWith(fs.realpathSync(source) + path.sep) ||
    !fs.statSync(file).isFile()
  )
    throw Error("Selected promotion contract lock escapes consumer source");
  const result = {
    "contract-lock-path": relative,
    "contract-lock-digest":
      "sha256:" +
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
  return result;
}
