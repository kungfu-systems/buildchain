import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("usage: node scripts/strip-trailing-whitespace.mjs <file> [...]");
}

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const normalized = content.replace(/[ \t]+$/gm, "");
  if (normalized !== content) {
    fs.writeFileSync(file, normalized);
  }
}
