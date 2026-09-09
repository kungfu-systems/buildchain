import fs from "node:fs";
import path from "node:path";

// The action directory is the ownership boundary, including main and post bundles.
export function actionInventory(root) {
  const actions = [];
  if (!fs.existsSync(path.join(root, "actions"))) return actions;
  for (const capability of fs.readdirSync(path.join(root, "actions"), {
    withFileTypes: true,
  })) {
    if (!capability.isDirectory())
      throw new Error(`unexpected action root entry: ${capability.name}`);
    for (const node of fs.readdirSync(
      path.join(root, "actions", capability.name),
      { withFileTypes: true },
    )) {
      if (!node.isDirectory())
        throw new Error(
          `unexpected action capability entry: ${capability.name}/${node.name}`,
        );
      const directory = `actions/${capability.name}/${node.name}`;
      const metadata = path.join(root, directory, "action.yml");
      if (!fs.existsSync(metadata))
        throw new Error(`${directory} has no action.yml`);
      const source = fs.readFileSync(metadata, "utf8");
      const using = source.match(
        /^  using:\s*["']?(composite|node24)["']?\s*$/mu,
      )?.[1];
      if (!using) throw new Error(`${directory} has unsupported runtime`);
      const bundles = [];
      if (using === "node24") {
        for (const match of source.matchAll(
          /^  (?:main|post):\s*["']?(dist\/[\w.-]+\.js)["']?\s*$/gmu,
        ))
          bundles.push(`${directory}/${match[1]}`);
        if (bundles.length === 0)
          throw new Error(`${directory} has no declared entry bundle`);
        const pkg = JSON.parse(
          fs.readFileSync(path.join(root, directory, "package.json"), "utf8"),
        );
        if (pkg.scripts?.build?.includes("copy-domain-wasm.mjs"))
          bundles.push(`${directory}/dist/buildchain-domain.wasm`);
      }
      actions.push({
        capability: capability.name,
        node: node.name,
        directory,
        using,
        bundles,
      });
    }
  }
  return actions.sort((a, b) => a.directory.localeCompare(b.directory));
}
