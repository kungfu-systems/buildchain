import fs from "node:fs";

export function materializeCommandShim(file, source, { mode = 0o755 } = {}) {
  fs.writeFileSync(file, source, { mode });
  if (process.platform === "win32") {
    const interpreter = /^#!.*\bnode\b/.test(source) ? `"${process.execPath}"` : "bash";
    fs.writeFileSync(`${file}.cmd`, `@echo off\r\n${interpreter} "${file}" %*\r\n`);
  }
  return file;
}
