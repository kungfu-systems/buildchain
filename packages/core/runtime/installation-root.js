import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Locate resources beside the executing source/bundle, independently of action
// nesting and consumer cwd. This locates bytes; it never grants runtime authority.
export function installationRoot(entryUrl) {
  let directory = path.dirname(fs.realpathSync(fileURLToPath(entryUrl)));
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.name === "@kungfu-tech/buildchain") {
        if (
          !fs.existsSync(path.join(directory, "bin/buildchain.mjs")) ||
          !fs.existsSync(path.join(directory, "architecture/code-layout.json"))
        )
          throw new Error(
            "Buildchain distribution is missing its CLI or layout contract",
          );
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Executing module is outside a Buildchain distribution");
    directory = parent;
  }
}
