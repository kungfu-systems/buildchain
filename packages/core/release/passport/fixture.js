import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverAssetsFromDir } from "./discovery.js";
import { CONTRACTS } from "./identity.js";
export function makeReleasePassportFixtureAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const names = [
    `buildchain-${process.platform}-${process.arch}.tar.gz`,
    "checksums.txt",
  ];
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `${name}${os.EOL}`);
  }
  return discoverAssetsFromDir(dir);
}
export function validateKnownReleasePassportContracts() {
  return [...CONTRACTS];
}
