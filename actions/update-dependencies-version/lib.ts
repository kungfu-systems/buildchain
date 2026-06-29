import { Octokit } from "@octokit/rest";
import semver from "semver";
import fs from "fs";
import os from "os";
import path from "path";
import * as glob from "glob";

export type argvs = {
  token: string;
  repo?: string;
  repoIncludes?: string;
  repoInExcludes?: string;
  pullRequestTitle: string;
};

export async function update(argv: argvs) {
  const isAlpha = argv.pullRequestTitle.includes("-alpha");
  const version = argv.pullRequestTitle.split(" v")[1];
  if (!version || isAlpha) {
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
  for (const repoName of repos) {
    console.log(`------------repo ${repoName} match----------`);
    await changeVersion(
      argv.token,
      repoName,
      ref("dev"),
      `~${major}.${minor}.0 || ~${major}.${minor}.${
        isAlpha ? patch : +patch + 1
      }-0`
    );
    console.log(`------------repo ${repoName} end----------`);
  }
}

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
    },
  } as any;
  const { prefix, prefixUi } = rules[argv.repo] || {};
  if (!prefix) {
    return [];
  }

  return [...repos.keys()].filter((repoName: string) => {
    if (excludes.includes(repoName)) {
      return false;
    }
    if (includes.length > 0 && !includes.includes(repoName)) {
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

async function changeVersion(
  token: string,
  repo: string,
  branch: string,
  version: string
) {
  const octokit = new Octokit({
    auth: token,
  });
  const lerna = await getGithubFile(octokit, repo, branch, "lerna.json");
  const deps = getPkgNameMap();
  for (const element of lerna?.content?.packages || []) {
    const folder = element.replace("/*", "");
    const menu = await getGithubMenu(octokit, repo, branch, folder);
    for (const child of menu || []) {
      await updatePackageJson({
        octokit,
        repo,
        branch,
        version,
        deps,
        address: `${folder}/${child}/package.json`,
      });
    }
  }
  await updatePackageJson({
    octokit,
    repo,
    branch,
    version,
    deps,
    address: `package.json`,
  });
}

async function updatePackageJson({
  octokit,
  repo,
  branch,
  address,
  version,
  deps,
}: {
  octokit: any;
  repo: string;
  branch: string;
  address: string;
  version: string;
  deps: string[];
}) {
  const pkg = await getGithubFile(octokit, repo, branch, address);
  if (pkg) {
    let count = 0;
    const { content, sha } = pkg;
    ["dependencies", "devDependencies", "resolutions"].forEach((item) => {
      deps.forEach((dep: string) => {
        if (content[item]?.[dep] && content[item]?.[dep] !== version) {
          content[item][dep] = version;
          count += 1;
        }
      });
    });
    console.log(`--- ${address} has ${count} changed ---`);
    if (count > 0) {
      console.log(content);
      await updateGithubFile(
        octokit,
        repo,
        branch,
        address,
        format(content),
        sha
      );
    }
  }
}

async function getGithubFile(
  octokit: any,
  repo: string,
  ref: string,
  path: string
) {
  return octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res: any) => {
      return {
        content: JSON.parse(
          Buffer.from(res?.data?.content, "base64").toString("utf-8")
        ),
        sha: res.data?.sha,
      };
    })
    .catch((e: any) => console.error(e));
}

async function updateGithubFile(
  octokit: any,
  repo: string,
  ref: string,
  path: string,
  content: string,
  sha: string
) {
  return octokit
    .request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      message: `update ${path}`,
      content,
      sha,
      branch: ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
        accept: "application/vnd.github+json",
      },
    })
    .catch((e: any) => console.error(e));
}

async function getGithubMenu(
  octokit: any,
  repo: string,
  ref: string,
  path: string
) {
  return octokit
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "kungfu-trader",
      repo,
      path,
      ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((res: { data: any[] }) => {
      return res.data.map((v) => v.name);
    })
    .catch((e: any) => console.error(e));
}

const getPkgConfig = (cwd: string, link: string): { [key: string]: any } => {
  return JSON.parse(fs.readFileSync(path.join(cwd, link), "utf-8"));
};

const getPkgNameMap = (): string[] => {
  const cwd = process.cwd();
  const hasLerna = fs.existsSync(path.join(cwd, "lerna.json"));
  const config = getPkgConfig(cwd, hasLerna ? "lerna.json" : "package.json");
  if (hasLerna) {
    const items = config.packages
      .map((x: string) =>
        glob.sync(`${x}/package.json`).reduce((acc: string[], link) => {
          const { name, publishConfig } = getPkgConfig(cwd, link);
          publishConfig && acc.push(name);
          return acc;
        }, [])
      )
      .flat();
    return items;
  }
  return [config.name];
};

function format(str: any) {
  return Buffer.from(JSON.stringify(str, null, 2) + os.EOL, "utf-8").toString(
    "base64"
  );
}
