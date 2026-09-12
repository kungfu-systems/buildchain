import fs from "node:fs";
fs.mkdirSync("dist", { recursive: true });
fs.mkdirSync("dist/package", { recursive: true });
fs.writeFileSync("dist/package/index.js", 'export const hello = "hello";\n');
fs.writeFileSync("dist/package/package.json", JSON.stringify({ name: "@example/minimal", version: JSON.parse(fs.readFileSync("package.json")).version, type: "module", exports: "./index.js" }));
