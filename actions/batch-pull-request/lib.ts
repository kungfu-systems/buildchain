import { Octokit } from "@octokit/rest";
import shell from "shelljs";
import semver from "semver";
import {
  commandForKungfuUpgrade,
  detectPackageManager,
} from "../../packages/core/package-manager.cjs";

export type argvs = {
  token: string;
  branch: string;
  version: string;
  pullRequestTitle?: string;
  repo?: string;
  repoIncludes?: string;
  repoInExcludes?: string;
};

export async function batchPullRequest(argv: argvs) {
  const repos = await filterRepos(argv);
  for (const repoName of repos) {
    const { head, base } =
      repoName === "kungfu"
        ? getBranchRef(argv, 2, (Number(argv.branch) + 1.4).toString())
        : getBranchRef(argv, argv.branch.split(".")[0], argv.branch);
    console.log(`------------repo ${repoName} match----------`);
    if (argv.version === "alpha") {
      await upgradeKf(argv.token, repoName, head);
    }
    await creatPullRequest(argv.token, repoName, head, base, argv.version);
    if (argv.version !== "alpha") {
      await sleep(5000);
    }
  }
}

const sleep = function (ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export async function getReops(argv: argvs): Promise<Map<string, string>> {
  const octokit = new Octokit({
    auth: `${argv.token}`,
  });
  let currentPage = 1; //当前页，初始化为1
  const maxPerPage = 100;
  const repoList = new Map<string, string>();
  while (true) {
    const repos = await octokit.rest.repos.listForOrg({
      org: "kungfu-trader",
      per_page: maxPerPage,
      page: currentPage,
    });
    repos.data.forEach((it: any) => {
      repoList.set(it.name, it.owner.login);
    });
    if (repos.data.length < maxPerPage) {
      break;
    }
    currentPage++;
  }
  console.log(repoList.size, " repositories");
  return repoList;
}

export async function creatPullRequest(
  token: string,
  repo: string,
  head: string,
  base: string,
  alphaRelease: string
) {
  const octokit = new Octokit({
    auth: token,
  });
  let issueNumber = -1;
  try {
    await sleep(5000);
    const pulls = await octokit.request(
      `GET /repos/kungfu-trader/${repo}/pulls`,
      {
        owner: "kungfu-trader",
        repo,
        state: "open",
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (pulls.data.length > 0) {
      for (const item of pulls.data) {
        const prNo = item.number;
        if (item.head.ref === head && item.base.ref === base) {
          console.log("To close opened pull request:", prNo);
          await sleep(5000);
          await octokit.request(
            `PATCH /repos/kungfu-trader/${repo}/pulls/${prNo}`,
            {
              owner: "kungfu-trader",
              repo: repo,
              pull_number: prNo,
              state: "closed",
              headers: {
                "X-GitHub-Api-Version": "2022-11-28",
              },
            }
          );
        }
      }
    }
  } catch (e: any) {
    console.log(e);
  }

  try {
    await sleep(5000);
    const pr = await octokit.request(
      `POST /repos/kungfu-trader/${repo}/pulls`,
      {
        owner: "kungfu-trader",
        repo: repo,
        title: "new pull request",
        body: "new pull request body",
        head: head,
        base: base,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    issueNumber = pr.data.number;
    console.log(
      `pull request for repo ${repo} success, pull request nunber: ${issueNumber}`
    );
  } catch (e: any) {
    console.warn(`pull request for repo ${repo} fail, reason: ${e.message}`);
  }
  if (issueNumber > 0) {
    await sleep(5000);
    try {
      await octokit.request(
        `PATCH /repos/kungfu-trader/${repo}/issues/${issueNumber}`,
        {
          owner: "kungfu-trader",
          repo: repo,
          issue_number: issueNumber,
          labels: ["batch_upgrade_" + alphaRelease],
          headers: {
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
    } catch (e: any) {
      console.log(
        `create tag for pull request for repo ${repo} issueNumber ${issueNumber} fail, reason: ${e.message}`
      );
    }
  }
}

const filterRepos = async (argv: argvs) => {
  const excludes = (argv.repoInExcludes || "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => !!v);
  const includes = (argv.repoIncludes || "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => !!v);
  if (!argv.repo) {
    return includes;
  }
  const repos = await getReops(argv);
  const rules = {
    broker: {
      prefix: "kfx-broker",
    },
    task: {
      prefix: "kfx-task",
      prefixUi: "kfx-ui",
    },
    trader: {
      prefix: "kungfu-trader",
    },
    kungfu: {
      prefix: "kungfu",
    },
    group: {
      prefix: "kfx-group",
      excludes: ["kfx-group-broker-stock", "kfx-group-broker-multi"],
    },
    "multi&stock": {
      prefix: "kfx-groupxs",
      includes: ["kfx-group-broker-stock", "kfx-group-broker-multi"],
    },
  } as any;
  const {
    prefix,
    prefixUi,
    excludes: ruleExcludes,
    includes: ruleIncludes,
  } = rules[argv.repo] || {};
  if (!prefix) {
    return [];
  }
  if (ruleExcludes) {
    ruleExcludes.forEach((e: string) => {
      !excludes.includes(e) && excludes.push(e);
    });
  }
  if (ruleIncludes) {
    ruleIncludes.forEach((e: string) => {
      !includes.includes(e) && includes.push(e);
    });
  }
  console.log(includes, excludes, prefix);
  return [...repos.keys()].filter((repoName: string) => {
    if (includes.length > 0 && !includes.includes(repoName)) {
      return false;
    }
    if (includes.includes(repoName)) {
      return true;
    }
    if (excludes.includes(repoName)) {
      return false;
    }
    if (prefix === "kungfu") {
      return ["kungfu-license", "kungfu"].includes(repoName);
    }
    return (
      repoName.startsWith(prefix) || (prefixUi && repoName.startsWith(prefixUi))
    );
  });
};

export async function npmrc(nodeToken: string) {
  const cmdToken = `echo '//npm.pkg.github.com/:_authToken=${nodeToken}' >> ~/.npmrc`;
  shell.exec(cmdToken);
  shell.exec(
    "echo '@kungfu-trader:registry=https://npm.pkg.github.com/' >> ~/.npmrc"
  );
  shell.exec("echo 'always-auth=false' >> ~/.npmrc");
}

async function upgradeKf(token: string, repo: string, head: string) {
  console.log(`---------upgrade kungfu core for ${repo}-----------`);
  shell.exec("pwd");
  shell.exec(`git clone https://${token}@github.com/kungfu-trader/${repo}.git`);
  console.log("1 clone");
  shell.cd(repo);
  shell.exec("git config --global user.name kungfu");
  shell.exec("git config --global user.email kungfu@users.noreply.github.com");
  console.log("2 cd");
  shell.exec("pwd");
  const { stdout, stderr, code } = shell.exec(`git switch ${head}`, {
    async: false,
  });
  console.log("stdout", stdout);
  console.log("stderr", stderr);
  console.log("code", code);
  if (code == 0) {
    let status;
    shell.exec("git pull");
    const manager = detectPackageManager(process.cwd()).name;
    const upgradeCommands = commandForKungfuUpgrade(manager);
    console.log(`package manager: ${manager}`);
    const { code: upgradeCode } = shell.exec(upgradeCommands.primary);
    status = upgradeCode;
    if (upgradeCode != 0) {
      const { code: importCode } = shell.exec(upgradeCommands.fallback);
      status = importCode;
    }
    console.log("..........");
    console.log("3 upgrade", status);
    if (status == 0) {
      shell.exec("git commit -am 'auto upgrade kungfu-trader'");
      console.log("4 commit");
      shell.exec(`git push origin ${head}`);
      console.log("5 pushs");
    }
    shell.cd("../");
    shell.exec("pwd");
    shell.exec("ls");
    shell.exec(`rm -rf ${repo}`);
    console.log("6 ls finish");
  } else {
    console.log(`no branch ${head}`);
  }
}

function getBranchRef(argv: argvs, mainVer: string | number, branch: string) {
  let head = "dev/v1/v1.0";
  let base = "alpha/v1/v1.0";
  if (argv.version == "alpha") {
    head = `dev/v${mainVer}/v` + branch;
    base = `alpha/v${mainVer}/v` + branch;
  } else if (argv.version == "release") {
    head = `alpha/v${mainVer}/v` + branch;
    base = `release/v${mainVer}/v` + branch;
  }
  console.log("head", head, "base", base);
  return { head, base };
}

export async function designatedPullRequest(argv: argvs) {
  const version = argv.pullRequestTitle?.split(" v")[1];
  if (!version) {
    return;
  }
  const repos = await filterRepos(argv);
  const {
    major,
    minor,
    patch,
    prerelease: [_, alpha],
  } = semver.parse(version)!;
  const ref = (head: string) => `${head}/v${major}/v${major}.${minor}`;
  console.log("head", ref("dev"), "base", ref("alpha"));
  for (const repoName of repos) {
    console.log(`------------repo ${repoName} match----------`);
    await upgradeKf(argv.token, repoName, ref("dev"));
    await creatPullRequest(
      argv.token,
      repoName,
      ref("dev"),
      ref("alpha"),
      "alpha"
    );
  }
}
