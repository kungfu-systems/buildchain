import fs from "node:fs";
import os from "node:os";

if (process.platform === "win32" && process.env.CI) {
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
}

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
