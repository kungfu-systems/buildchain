import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/install.txt", "install ok\n");
