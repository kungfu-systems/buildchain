import fs from "node:fs";

for (const file of ["dist/install.txt", "dist/libnode-shaped.txt"]) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing fixture output: ${file}`);
  }
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync("libnode.release.json", "utf8"));
if (pkg.version !== anchor.npmVersion) {
  throw new Error(`package version ${pkg.version} does not match anchor npmVersion ${anchor.npmVersion}`);
}
if (!anchor.nodeTag || !anchor.nodeTag.startsWith("v")) {
  throw new Error("anchor nodeTag must be v-prefixed");
}
