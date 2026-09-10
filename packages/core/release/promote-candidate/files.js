import fs from "node:fs";
import path from "node:path";
export const read = (file) =>
  JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
export const write = (file, value) => {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
};
