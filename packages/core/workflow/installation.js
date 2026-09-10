import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installationRoot } from "../runtime/installation-root.js";

// A consumer-owned recovery package carries only trusted admission and settlement
// actions. Locating it never gives those bytes candidate execution authority.
export function workflowInstallationRoot(entryUrl) {
  let directory = path.dirname(fs.realpathSync(fileURLToPath(entryUrl)));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@kungfu-tech/buildchain")
        return installationRoot(entryUrl);
      if (manifest.name === "buildchain-consumer-recovery") {
        const distribution = JSON.parse(
          fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
        );
        if (
          distribution.schema !==
          "buildchain.bootstrap-recovery-distribution/v1"
        )
          throw new Error("Unsupported consumer recovery distribution");
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Workflow action is outside a declared distribution");
    directory = parent;
  }
}
