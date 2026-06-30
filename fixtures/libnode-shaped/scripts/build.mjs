import fs from "node:fs";
import os from "node:os";

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync(
  "dist/libnode-shaped.txt",
  JSON.stringify(
    {
      fixture: "libnode-shaped",
      platform: os.platform(),
      arch: os.arch(),
    },
    null,
    2,
  ) + "\n",
);
