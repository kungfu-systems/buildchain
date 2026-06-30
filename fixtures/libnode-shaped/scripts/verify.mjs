import fs from "node:fs";

for (const file of ["dist/install.txt", "dist/libnode-shaped.txt"]) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing fixture output: ${file}`);
  }
}
