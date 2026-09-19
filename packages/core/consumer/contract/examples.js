import { choice } from "./shape.js";
import { consumerWorkflows } from "./entries.js";
import { CONFIG_PATH } from "./plan.js";
import { PRODUCT_TYPES } from "./products.js";

const ARTIFACTS = {
  npm: { path: "dist/package", kind: "npm-package", provider: "npm" },
  binary: {
    path: "dist/hello.tar.gz",
    kind: "archive",
    provider: "github-release",
  },
  paper: { path: "dist/paper.pdf", kind: "pdf", provider: "github-release" },
};

function productSource(type) {
  const prefix =
    'import fs from "node:fs";\nfs.mkdirSync("dist", { recursive: true });\n';
  if (type === "npm")
    return `${prefix}fs.mkdirSync("dist/package", { recursive: true });\nfs.writeFileSync("dist/package/index.js", 'export const hello = "hello";\\n');\nfs.writeFileSync("dist/package/package.json", JSON.stringify({ name: "@example/minimal", version: JSON.parse(fs.readFileSync("package.json")).version, type: "module", exports: "./index.js" }));\n`;
  if (type === "binary")
    return `${prefix}import { execFileSync } from "node:child_process";\nexecFileSync("cc", ["src/hello.c", "-o", "dist/hello"], { stdio: "inherit" });\nexecFileSync("tar", ["-czf", "dist/hello.tar.gz", "-C", "dist", "hello"], { stdio: "inherit" });\n`;
  return `${prefix}const stream = "BT /F1 24 Tf 50 700 Td (Minimal Paper) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", \`<< /Length \${stream.length} >>\\nstream\\n\${stream}\\nendstream\`];
let pdf = "%PDF-1.4\\n";
const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += \`\${index + 1} 0 obj\\n\${object}\\nendobj\\n\`; }
const xref = Buffer.byteLength(pdf);
pdf += \`xref\\n0 \${offsets.length}\\n0000000000 65535 f \\n\`;
for (const offset of offsets.slice(1)) pdf += \`\${String(offset).padStart(10, "0")} 00000 n \\n\`;
pdf += \`trailer\\n<< /Size \${offsets.length} /Root 1 0 R >>\\nstartxref\\n\${xref}\\n%%EOF\\n\`;
fs.writeFileSync("dist/paper.pdf", pdf);
`;
}

export function standardConsumerExample(type, channel = "v4") {
  choice(type, PRODUCT_TYPES, "product.type");
  const artifact = ARTIFACTS[type];
  const npmAccess = type === "npm" ? 'access = "public"\n' : "";
  const files = {
    ...consumerWorkflows(channel),
    "package.json": `${JSON.stringify({ name: `minimal-${type}`, private: true, version: "1.0.0-alpha.1", type: "module" }, null, 2)}\n`,
    "src/build.mjs": productSource(type),
    "src/verify.mjs": `import assert from "node:assert/strict";\nimport fs from "node:fs";\nassert.ok(fs.statSync(${JSON.stringify(artifact.path)}).${type === "npm" ? "isDirectory()" : "size > 0"});\n`,
    [CONFIG_PATH]: `schema = 2

[[products]]
id = "main"
type = "${type}"
platforms = ["linux-x64"]
build = ["node src/build.mjs"]
verify = ["node src/verify.mjs"]

[[products.artifacts]]
id = "main"
path = "${artifact.path}"
kind = "${artifact.kind}"

[[products.targets]]
provider = "${artifact.provider}"
artifacts = ["main"]
${npmAccess}
[version]
strategy = "semver"

[[version.files]]
path = "package.json"
format = "json"
key = "version"

[[channels]]
from = "feature/*"
to = "dev/v1/v1.0"
operation = "develop"

[[channels]]
from = "dev/v1/v1.0"
to = "alpha/v1/v1.0"
operation = "alpha"

[[channels]]
from = "alpha/v1/v1.0"
to = "release/v1/v1.0"
operation = "stable"

[review]
minimum_approvals = 1
code_owners = true
merge_queue = true
`,
  };
  if (type === "binary")
    files["src/hello.c"] =
      '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n';
  return files;
}
