import path from "node:path";
import fs from "node:fs";
import { sync as globSync } from "glob";
import { spawnSync } from "node:child_process";
import {
  getCurrentLockInfo,
  getYarnLockInfo,
} from "../../../packages/core/package-manager.js";

export const getCurrentPackageLock = () => {
  try {
    return getCurrentLockInfo(process.cwd());
  } catch (error) {
    console.error(error);
  }
};

export const writeFile = (fileName, content, folder) => {
  if (!fs.existsSync(path.join(process.cwd(), folder))) {
    fs.mkdirSync(path.join(process.cwd(), folder));
  }
  fs.writeFileSync(fileName, content);
};

export function awsCall(args, opts) {
  console.log(`$ aws ${args.join(" ")}`);
  const result = spawnSync("aws", args, opts);
  if (result.status !== 0) {
    throw new Error(`Failed to call aws with status ${result.status}`);
  }
  return result;
}

export const getPkgNameMap = (filterBinary = true) => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
  if (hasLerna) {
    const items = config.packages
      .map((x) =>
        globSync(`${x}/package.json`).reduce((acc, link) => {
          const { name, binary } = getPkgConfig(cwd, link);
          !(filterBinary && !binary) && acc.push(name);
          return acc;
        }, [])
      )
      .flat();
    return items;
  }
  return [config.name];
};

export const getPkgConfig = (cwd, link = "package.json") => {
  return JSON.parse(fs.readFileSync(path.join(cwd || process.cwd(), link)));
};

export const getArtifactMap = () => {
  const cwd = process.cwd();
  return globSync("artifact*/package.json").map((v) => getPkgConfig(cwd, v));
};

export { getYarnLockInfo };
