import fs from "node:fs";
import path from "node:path";

const outDir = path.join(process.cwd(), "dist");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "index.html"),
  "<!doctype html><html><head><meta name=\"robots\" content=\"noindex\"></head><body>Kungfu web surface fixture</body></html>\n",
);

