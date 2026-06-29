const path = require("path");
const fs = require("fs");
const axios = require("axios");
const marked = require("marked");
const mustache = require("mustache");
const sortBy = require("lodash.sortby");
const {
  awsCall,
  writeFile,
  getPkgNameMap,
  getArtifactMap,
  getCurrentYarnLock,
} = require("./utils");
const { htmlDir, platforms, suffixs } = require("./const");

const spawnOpts = {
  shell: true,
  stdio: "pipe",
  encoding: "utf-8",
  windowsHide: true,
};

const getMenu = require("../template/menu");

const downloadBaseUrl = "https://download.kungfu-trader.com/";
const releaseBaseUrl = "https://releases.kungfu-trader.com/";

const generateHTML = async (argv) => {
  const artifacts = getArtifactMap().map((v) => v.name);
  const pkgInfo = getPkgNameMap();
  const version = argv.pullRequestTitle.split(" ")[1];
  for (const artifactName of artifacts.length > 0 ? artifacts : pkgInfo) {
    const options = {
      ...argv,
      version,
      artifactName: artifactName.replace("@kungfu-trader/", ""),
    };
    await createPage(options, downloadBaseUrl);
    await transfer(options, `${getArtifactPath(version)}/`);
    await clear();
  }
};

const getDownloadList = async (argv, downloadBaseUrl, artifactName) => {
  try {
    const artifactPath = `${artifactName}/${getArtifactPath(argv.version)}/`;
    const source = `s3://${argv.bucketPrebuilt}/${artifactPath}`;
    const result = await awsCall(
      ["s3", "ls", source, "--human-readable"],
      spawnOpts
    );
    const items = result.stdout
      .split("\n")
      .filter((v) => !!v)
      .reduce((acc, cur) => {
        const [date, time, size, sizeUnit, name] = cur
          .split(" ")
          .filter((v) => !!v);
        const isHit = suffixs.some((suffix) => name.endsWith(suffix));
        if (isHit) {
          acc.push({
            date: dateFormat(`${date} ${time}`),
            size: `${size} ${sizeUnit}`,
            name,
            url: `${downloadBaseUrl}${artifactPath}${name}`,
            platform: platforms.find((v) => name.includes(v)),
          });
        }
        return acc;
      }, []);
    return sortBy(items, ({ name, platform }) =>
      platform
        ? platforms.findIndex((x) => platform.includes(x))
        : suffixs.findIndex((x) => name.endsWith(x)) + platforms.length
    );
  } catch (error) {
    return [];
  }
};

const getReleaseNoteList = async (argv, releaseBaseUrl) => {
  try {
    const awsObject = await awsCall(
      [
        "s3api",
        "list-objects-v2",
        `--bucket ${argv.bucketRelease}`,
        `--prefix ${argv.artifactName}/${getArtifactPath(argv.version)}/`,
        `--query "Contents[?contains(Key, 'release-notes')]"`,
      ],
      spawnOpts
    );
    const result = JSON.parse(awsObject.stdout);
    return Object.fromEntries(
      Object.entries({
        mdUrl: result.find((v) => v.Key.endsWith(".md"))?.Key,
        pdfUrl: result.find((v) => v.Key.endsWith(".pdf"))?.Key,
        htmlUrl: result.find((v) => v.Key.endsWith(".html"))?.Key,
        rstUrl: result.find((v) => v.Key.endsWith(".rst"))?.Key,
      })
        .filter((v) => !!v[1])
        .map((v) => [v[0], releaseBaseUrl + v[1]])
    );
  } catch {
    return {};
  }
};

const createPage = async (argv, downloadBaseUrl) => {
  const artifact = getArtifactMap().find((v) =>
    v.name.endsWith(`/${argv.artifactName}`)
  );
  const deps = Object.keys(artifact?.dependencies ?? {});
  const items = artifact
    ? getPkgNameMap(false)
        .filter((v) => deps.includes(v) || v.includes("/example"))
        .sort()
    : [];
  // const items = [
  //   "@kungfu-trader/kungfu-js-api",
  //   "@kungfu-trader/kungfu-app",
  //   "@kungfu-trader/kungfu-cli",
  //   "@kungfu-trader/kungfu-core",
  //   "@kungfu-trader/kungfu-sdk",
  //   "@kungfu-trader/kungfu-toolchain",
  //   "@kungfu-trader/kfx-operator-bar",
  //   "@kungfu-trader/kfx-indexer-live",
  //   "@kungfu-trader/kfx-matcher-101-cpp",
  //   "@kungfu-trader/kfx-broker-sim",
  //   "@kungfu-trader/kfx-broker-xtp-demo",
  //   "@kungfu-trader/examples-operator-cpp",
  //   "@kungfu-trader/examples-operator-python",
  //   "@kungfu-trader/example-report-cpp",
  //   "@kungfu-trader/example-report-python",
  //   "@kungfu-trader/examples-data-tool",
  //   "@kungfu-trader/examples-strategy-cpp",
  //   "@kungfu-trader/examples-strategy-python",
  // ];
  const tableItem = await Promise.all([
    getDownloadList(argv, downloadBaseUrl, argv.artifactName),
    ...items.map((v) =>
      getDownloadList(argv, downloadBaseUrl, v.replace("@kungfu-trader/", ""))
    ),
  ]).then((res) => res.flat(2));
  const releaseNotes = await getReleaseNoteList(argv, releaseBaseUrl);
  const template = fs.readFileSync(
    path.join(__dirname, "../template/release-detail.html"),
    "utf-8"
  );
  const output = mustache.render(template, {
    artifactName: argv.repo,
    version: argv.version,
    hasNotes: !!releaseNotes.mdUrl,
    homeUrl: releaseBaseUrl,
    tableItem,
    created: dateFormat(),
    ...releaseNotes,
    notes: releaseNotes.mdUrl ? await mdtoHtml(releaseNotes.mdUrl) : "",
    title: `下载${argv.repo} ${argv.version} - 功夫量化`,
    ...getMenu(argv.artifactName)
  });
  const fileName = path.join(process.cwd(), `${htmlDir}/index.html`);
  writeFile(fileName, output, htmlDir);
};

const mdtoHtml = (url) => {
  return axios(url)
    .then((res) => marked.parse(res.data))
    .catch((e) => console.log(e));
};
const transfer = (argv, link = "") => {
  const source = path.join(process.cwd(), htmlDir);
  const dest = `s3://${argv.bucketRelease}/${argv.artifactName}/${link}`;
  awsCall([
    "s3",
    "sync",
    source,
    dest,
    "--acl",
    "public-read",
    "--only-show-errors",
  ]);
};

const clear = () => {
  fs.rmdirSync(path.join(process.cwd(), htmlDir), {
    force: true,
    recursive: true,
  });
};

const dateFormat = (str) => {
  const date = str ? new Date(str) : new Date();
  // date.setHours(date.getHours() + 8);
  return date.toLocaleString("zh");
};

const getArtifactPath = (version) => {
  return `${version.split(".")[0]}/${version}`;
};

module.exports = {
  generateHTML,
};
