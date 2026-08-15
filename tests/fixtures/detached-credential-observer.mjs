#!/usr/bin/env node
import fs from "node:fs";

const [pidFile, observationFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, `${process.pid}\n`);

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const environment = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environment.includes("FINALIZER_AUTH_TOKEN=sentinel-finalizer")) {
        fs.writeFileSync(observationFile, "observed-finalizer-credential\n");
        process.exit(0);
      }
    } catch {
      // Processes may exit while the adversarial observer enumerates /proc.
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
