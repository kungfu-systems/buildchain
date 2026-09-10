import fs from "node:fs";
import path from "node:path";

// Resource ownership follows the emitted module-relative reference, including post.
export function actionBundleResources(bundlePath) {
  if (!fs.existsSync(bundlePath)) return [];
  const source = fs.readFileSync(bundlePath, "utf8");
  return /["']\.\/buildchain-domain\.wasm["']/u.test(source)
    ? [path.join(path.dirname(bundlePath), "buildchain-domain.wasm")]
    : [];
}

// The action directory is the ownership boundary, including main and post bundles.
export function actionInventory(root) {
  const actions = [];
  if (!fs.existsSync(path.join(root, "actions"))) return actions;
  for (const capability of fs.readdirSync(path.join(root, "actions"), {
    withFileTypes: true,
  })) {
    if (!capability.isDirectory())
      throw new Error(`unexpected action root entry: ${capability.name}`);
    for (const group of fs.readdirSync(
      path.join(root, "actions", capability.name),
      { withFileTypes: true },
    )) {
      if (!group.isDirectory())
        throw new Error(
          `unexpected action capability entry: ${capability.name}/${group.name}`,
        );
      const groupDirectory = `actions/${capability.name}/${group.name}`;
      if (fs.existsSync(path.join(root, groupDirectory, "action.yml")))
        throw new Error(
          `${groupDirectory}: action requires a responsibility group and operation`,
        );
      for (const node of fs.readdirSync(path.join(root, groupDirectory), {
        withFileTypes: true,
      })) {
        if (!node.isDirectory())
          throw new Error(
            `unexpected action group entry: ${groupDirectory}/${node.name}`,
          );
        const directory = `${groupDirectory}/${node.name}`;
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
          const resources = bundles.flatMap((bundle) =>
            actionBundleResources(path.join(root, bundle)).map((resource) =>
              path.relative(root, resource).split(path.sep).join("/"),
            ),
          );
          bundles.push(...new Set(resources));
        }
        actions.push({
          capability: capability.name,
          group: group.name,
          node: node.name,
          directory,
          using,
          bundles,
        });
      }
    }
  }
  return actions.sort((a, b) => a.directory.localeCompare(b.directory));
}
