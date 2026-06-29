const path = require("path");
const fs = require("fs");
const glob = require("glob");
const { spawnSync } = require("child_process");
const lockfile = require("@yarnpkg/lockfile");

const getCurrentYarnLock = () => {
  try {
    return getYarnLockInfo(
      fs.readFileSync(path.join(process.cwd(), "yarn.lock"), "utf8")
    );
  } catch (error) {
    console.error(error);
  }
};

const writeFile = (fileName, content, folder) => {
  if (!fs.existsSync(path.join(process.cwd(), folder))) {
    fs.mkdirSync(path.join(process.cwd(), folder));
  }
  fs.writeFileSync(fileName, content);
};

function awsCall(args, opts) {
  console.log(`$ aws ${args.join(" ")}`);
  const result = spawnSync("aws", args, opts);
  if (result.status !== 0) {
    throw new Error(`Failed to call aws with status ${result.status}`);
  }
  return result;
}

const getPkgNameMap = (filterBinary = true) => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
  if (hasLerna) {
    const items = config.packages
      .map((x) =>
        glob.sync(`${x}/package.json`).reduce((acc, link) => {
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

const getPkgConfig = (cwd, link = "package.json") => {
  return JSON.parse(fs.readFileSync(path.join(cwd || process.cwd(), link)));
};

const getArtifactMap = () => {
  const cwd = process.cwd();
  return glob.sync("artifact*/package.json").map((v) => getPkgConfig(cwd, v));
};

const getYarnLockInfo = function (content) {
  if (!content) {
    return;
  }
  const json = lockfile.parse(content);
  return filterBy(json.object).reduce((acc, [key, value]) => {
    acc.set("@" + key.split("@")[1], value.version);
    return acc;
  }, new Map());
};

const filterBy = (items) => {
  if (!items) {
    return [];
  }
  return Object.entries(items).filter(([key]) =>
    key.startsWith("@kungfu-trader/")
  );
};

module.exports = {
  getPkgNameMap,
  getPkgConfig,
  awsCall,
  writeFile,
  getArtifactMap,
  getYarnLockInfo,
  getCurrentYarnLock,
};
