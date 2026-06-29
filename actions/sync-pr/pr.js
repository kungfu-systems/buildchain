const { Octokit } = require("@octokit/rest");
const axios = require("axios");

const sleep = function (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

async function updateAirtableRecord(
  url,
  dataList,
  airtableApiKey,
  fieldsToMerge
) {
  let tryagain = 0;
  while (tryagain < 3) {
    try {
      const r = await axios.put(
        url,
        {
          performUpsert: {
            fieldsToMergeOn: fieldsToMerge,
          },
          records: dataList,
        },
        {
          headers: {
            Authorization: `Bearer ${airtableApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      // console.log(`updateAirtableRecord ${url} ${r.status}`);
      break;
    } catch (e) {
      console.log(e);
      tryagain++;
    }
  }
}

async function checkAndPush(
  url,
  dataList,
  airtableApiKey,
  check,
  fieldsToMerge
) {
  if ((check && dataList.length < 10) || dataList.length == 0) {
    return 0;
  }
  let count = 0;
  try {
    await updateAirtableRecord(url, dataList, airtableApiKey, fieldsToMerge);
    // let ret = "";
    // dataList.forEach((it) => {
    //   ret += it.fields.Url;
    //   ret += ";";
    // });
    count = dataList.length;
    // console.log("update ", count, " items; data table", ret);
    dataList.length = 0;
  } catch (e) {
    console.error(e);
  }
  return count;
}

exports.syncAirtableWithRest = async function (argv) {
  const octokit = new Octokit({
    auth: `${argv.token}`,
  });
  console.log("start get pr version 1.0.2-alpha.5");
  let currentPage = 1; //当前页，初始化为1
  const maxPerPage = 100;
  const repoList = new Map();
  let urlData = "https://api.airtable.com/v0/appAdi5zFFEsCzmEM/data";
  while (true) {
    const repos = await octokit.rest.repos.listForOrg({
      org: "kungfu-trader",
      per_page: maxPerPage,
      page: currentPage,
    });
    repos.data.forEach((it) => {
      repoList.set(it.name, it.owner.login);
    });
    if (repos.data.length < maxPerPage) {
      break;
    }
    currentPage++;
  }
  console.log(repoList.size, " repositories");
  const airtableApiKey = argv.apiKey;
  const Airtable = require("airtable");
  const base = new Airtable({ apiKey: airtableApiKey }).base(
    "appAdi5zFFEsCzmEM"
  );
  let dataCount = 0;
  let dataList = [];
  for (const [repoName, owner] of repoList) {
    // console.log(repoName);
    // if (repoName != "test") {
    //   continue;
    // }
    let curPage = 1;
    while (true) {
      const pulls = await octokit.rest.pulls.list({
        state: "all",
        owner: owner,
        repo: repoName,
        per_page: maxPerPage,
        page: curPage,
      });

      console.log(
        `${repoName} has ${pulls.data.length} pull requests in page ${curPage}`
      );
      for (const item of pulls.data) {
        try {
          const reviewer = [];
          item.requested_reviewers.forEach((it) => {
            reviewer.push(it.login);
          });
          dataList.push({
            fields: {
              Url: item.html_url,
              Pull_request: JSON.stringify({ pull_request: item }),
              Reviewer: reviewer.toString(),
              Repo: item.base.repo.name,
              State: item.state,
              "Pull Request Last Modified": item.updated_at,
            },
          });
        } catch (e) {
          console.error(e);
          continue;
        }
        // console.log(`periodly update ${dataCount} raw data`);
        let cnt = await checkAndPush(urlData, dataList, argv.apiKey, true, [
          "Url",
        ]);
        dataCount += cnt;
      }
      if (pulls.data.length < maxPerPage) {
        break;
      }
      curPage++;
    }
  }
  let cnt = await checkAndPush(urlData, dataList, argv.apiKey, false, ["Url"]);
  dataCount += cnt;
  console.log(`totally update ${dataCount} raw data`);
};
