const Bucket = "kungfu-prebuilt";

const { spawnSync } = require("child_process");

const spawnOptsInherit = { shell: true, stdio: "inherit", windowsHide: true };
const spawnOptsPipe = { shell: true, stdio: "pipe", windowsHide: true };

function awsCall(args, opts = spawnOptsInherit) {
  console.log(`$ aws ${args.join(" ")}`);
  const result = spawnSync("aws", args, opts);
  if (result.status !== 0) {
    throw new Error(`Failed to call aws with status ${result.status}`);
  }
  return result;
}

function awsOutput(args) {
  const result = awsCall(args, spawnOptsPipe);
  return result.output
    .filter((e) => e && e.length > 0)
    .toString()
    .trimEnd();
}

function s3ApiOutput(args) {
  return awsOutput(["s3api", ...args]);
}

function getProductMetaData(argv) {
  const { product, repo } = argv;
  if (!product) return [];

  const result = s3ApiOutput([
    "list-objects-v2",
    `--bucket ${Bucket}`,
    `--prefix ${product}/`,
    "--output json",
    "--query \"Contents[?ends_with(Key, '.zip') || ends_with(Key, '.dmg') || ends_with(Key, '.exe') || ends_with(Key, '.rpm') || ends_with(Key, '.AppImage')].[Key, LastModified]\"",
  ]);

  const contents = JSON.parse(result);

  const versions = contents.reduce(
    ({ list, cache }, [key, lastModified]) => {
      const [_p, _major, version, _filename] = key.split("/");
      const name = product.replace("artifact-", "");
      const coreVersion = "";

      if (cache.has(version)) return { list, cache };

      cache.add(version);
      list.push({
        version,
        name,
        repo: repo || name,
        timestamp: new Date(lastModified).getTime(),
        coreVersion: coreVersion ? `v${coreVersion}` : null,
        coreUrl: coreVersion
          ? `https://releases.libkungfu.cc/${getCurrentVersion(
              `v${coreVersion}`
            )}/index.html`
          : null,
      });

      return { list, cache };
    },
    { list: [], cache: new Set() }
  ).list;

  return versions;
}

module.exports = {
  getProductMetaData,
};
