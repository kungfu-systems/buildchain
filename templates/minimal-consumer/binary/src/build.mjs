import fs from "node:fs";
fs.mkdirSync("dist", { recursive: true });
import { execFileSync } from "node:child_process";
execFileSync("cc", ["src/hello.c", "-o", "dist/hello"], { stdio: "inherit" });
execFileSync("tar", ["-czf", "dist/hello.tar.gz", "-C", "dist", "hello"], { stdio: "inherit" });
