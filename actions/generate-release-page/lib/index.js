/* eslint-disable no-restricted-globals */
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const axios = require("axios");
const cheerio = require("cheerio");
const marked = require("marked");
const sortBy = require("lodash.sortby");
const { getProductMetaData } = require("./kungfu-prebuilt");
const { Octokit } = require("@octokit/rest");

exports.generate = async (argv) => {
  console.log(`Generating release page for ${argv.product}`);
  const outputDir = getOutputDir(argv);
  const result = await generateHTML(argv, outputDir);
  if (result) {
    await generateMetaData(outputDir, result.list?.stables);
  }
};

const generateHTML = async (argv, outputDir) => {
  const { template, config } = getTemplate(argv);
  const list = await getVersionList({ ...argv, ...config });
  const { readme = "" } = await getRepoInfo(argv);
  if (!list || !template || !config) {
    return;
  }
  const options = {
    baseUrl: argv.baseUrl,
    product: argv.product,
    productName: argv.productName,
    stables: JSON.stringify(list.stables),
    prereleases: JSON.stringify(list.prereleases),
    readme,
    title: argv.title || argv.product,
    ...config,
  };
  const output = mustache.render(template, options);
  console.log(`Writing release page to ${outputDir}`);
  const fileName = path.join(outputDir, "index.html");
  console.log(`Writing release page to ${fileName}`);
  fs.writeFileSync(fileName, output);
  generateDetail(argv, outputDir, options);
  return { list };
};

const generateMetaData = async (outputDir, items) => {
  const latest = sortBy(items, "weight")[0];
  if (latest) {
    fs.writeFileSync(
      path.join(outputDir, "meta.json"),
      JSON.stringify({
        latest: await getDownloadList(latest),
      })
    );
  }
};

const generateDetail = (argv, outputDir, options) => {
  const link = path.join(__dirname, `../templates/${argv.product}/detail.html`);
  const isTemplateExist = fs.existsSync(link);
  if (isTemplateExist) {
    const detailTemplate = fs.readFileSync(link, "utf-8");
    const output = mustache.render(detailTemplate, options);
    const fileName = path.join(outputDir, "detail.html");
    fs.writeFileSync(fileName, output);
  }
};

const getTemplate = (argv) => {
  let product = argv.product;
  const isTemplateExist = fs.existsSync(
    path.join(__dirname, `../templates/${product}/template.html`)
  );
  if (!isTemplateExist) {
    product = "default";
  }
  const template = fs.readFileSync(
    path.join(__dirname, `../templates/${product}/template.html`),
    "utf-8"
  );
  const config = fs.readFileSync(
    path.join(__dirname, `../templates/${product}/config.json`),
    "utf-8"
  );
  return { template, config: JSON.parse(config) };
};

const getDownloadList = async (latest) => {
  return axios
    .get(latest.relUrl)
    .then((res) => {
      const urls = [];
      const $ = cheerio.load(res.data);
      $("tbody td a").each((_, e) => urls.push($(e).attr("href")));
      return {
        version: latest.version,
        win_exe: urls.find((v) => v.includes("win-") && v.endsWith(".exe")),
        win_zip: urls.find((v) => v.includes("win-") && v.endsWith(".zip")),
        mac_dmg: urls.find((v) => v.includes("mac-") && v.endsWith(".dmg")),
        mac_zip: urls.find((v) => v.includes("mac-") && v.endsWith(".zip")),
        linux_zip: urls.find((v) => v.includes("linux-") && v.endsWith(".zip")),
        linux_appimage: urls.find(
          (v) => v.includes("linux-") && v.endsWith(".AppImage")
        ),
        linux_rpm: urls.find((v) => v.includes("linux-") && v.endsWith(".rpm")),
      };
    })
    .catch((e) => console.log(e));
};

const getVersionList = async (argv) => {
  const metadata = await getProductMetaData(argv);
  if (!Array.isArray(metadata) || metadata.length === 0) {
    return;
  }
  const len = metadata.length;
  const exclude = (argv.exclude || "")
    .split(",")
    .map((v) => v.trim().replace("v", ""))
    .filter((v) => !!v);
  const lowerEdgeWeight = getWeightingNumber(argv.lowerEdge, len);
  const upperEdgeWeight = getWeightingNumber(argv.upperEdge, len);
  const { stables, prereleases } = metadata.reduce(
    (acc, meta) => {
      const version = meta.version;
      const weight = getWeightingNumber(version, len);
      checkIsMatch(weight, lowerEdgeWeight, upperEdgeWeight) &&
        !exclude.includes(version.slice(1)) &&
        acc[version.includes("alpha") ? "prereleases" : "stables"].push(
          createVersionItem(argv, version, meta, len)
        );
      return acc;
    },
    { stables: [], prereleases: [] }
  );
  return {
    stables: sortBy(stables, (v) => -v.timestamp),
    prereleases: sortBy(prereleases, (v) => -v.timestamp),
  };
};

const createVersionItem = (argv, version, meta, len) => {
  const semverList = version.split(".");
  const url = `${argv.baseUrl}/${
    argv.useArtifactName ? argv.product + "/" : ""
  }${getCurrentVersion(version)}/index.html`;
  return {
    ...meta,
    version,
    url: argv.detailUrl ? `${argv.detailUrl}?version=${version}` : url,
    relUrl: url,
    weight: getWeightingNumber(version, len),
    parentId: `${semverList[0]}.${semverList[1]}`,
    docUrl:
      argv.docUrl && semverList[0] > 1
        ? `${argv.docUrl}/${semverList[0]}.${semverList[1]}/index.html`
        : null,
  };
};

const getRepoInfo = async (argv) => {
  const octokit = new Octokit({
    auth: argv.token,
  });
  const readme = await octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo: argv.repo,
      path: "README.md",
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res) => {
      return marked.parse(
        Buffer.from(res?.data?.content, "base64").toString("utf-8")
      );
    })
    .catch((e) => console.log(e));
  return { readme };
};

const getCurrentVersion = (version) => {
  return `${version.split(".")[0]}/${version}`;
};

const getWeightingNumber = (name, len) => {
  if (!name) {
    return;
  }
  const [v1, v2, v3, v4 = len] = name
    .replace("v", "")
    .replace("-alpha", "")
    .split(".");
  return (
    (v1 * len * 1000000 + v2 * len * 10000 + v3 * len * 100 + +v4 + 1) * -1
  );
};

const checkIsMatch = (weight, lowerEdgeWeight, upperEdgeWeight) => {
  if (lowerEdgeWeight && upperEdgeWeight) {
    return weight <= lowerEdgeWeight && weight >= upperEdgeWeight;
  }
  if (lowerEdgeWeight) {
    return weight <= lowerEdgeWeight;
  }
  if (upperEdgeWeight) {
    return weight >= upperEdgeWeight;
  }
  return true;
};

const getOutputDir = (argv) => {
  const outputDir = path.join(
    "dist",
    argv.product,
    "build",
    "stage",
    argv.releasePath
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
};
