import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { Octokit } from "@octokit/rest";
import { sync as globSync } from "glob";
import semver from "semver";
import { QA_INFO_CONTRAST, SPAWN_OPTS } from "./const";
export interface Argv {
  token: string;
  bucketPrebuilt: string;
  owner: string;
  qaRepo: string;
  repo: string;
  manualArtifactName?: string;
  manualVersion?: string;
  pullRequestTitle?: string;
}

export const dispatch = async function (argv: Argv) {
  const octokit = new Octokit({
    auth: argv.token,
  });
  const s3BaseUrl = await getBaseUrl(argv);
  const files = getFileList(argv);
  const items = files.filter(
    ({ Key }) => Key.endsWith(".zip") && Key.includes("win-x64")
  );
  for (const { Key } of items) {
    const qaInfo = getQaInfo(argv);
    console.log({
      owner: argv.owner,
      repo: argv.qaRepo,
      workflow_id: qaInfo?.workflow_id,
      ref: qaInfo?.ref,
      inputs: {
        app_zip_pack_url: s3BaseUrl + Key,
      },
    });
    if (qaInfo) {
      await octokit
        .request(
          "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
          {
            owner: argv.owner,
            repo: argv.qaRepo,
            workflow_id: qaInfo.workflow_id,
            ref: qaInfo.ref,
            inputs: {
              app_zip_pack_url: s3BaseUrl + Key,
            },
            headers: {
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        )
        .catch((e) => console.error(e));
    }
  }
};

const getBaseUrl = async ({ bucketPrebuilt }: Argv) => {
  const s3Location = awsOutput([
    "s3api",
    "get-bucket-location",
    "--bucket",
    bucketPrebuilt,
    "--output",
    "text",
  ]);
  const s3BaseUrlGlobal = `https://${bucketPrebuilt}.s3.amazonaws.com/`;
  const s3BaseUrlCN = `https://${bucketPrebuilt}.s3.${s3Location}.amazonaws.com.cn/`;
  return s3Location.startsWith("cn") ? s3BaseUrlCN : s3BaseUrlGlobal;
};

const getFileList = (argv: Argv) => {
  const artifactMap = argv.manualArtifactName
    ? [argv.manualArtifactName]
    : getArtifactMap();
  const version = formatVersion(
    argv.manualVersion ? argv.manualVersion : currentVersion(argv)
  );
  return artifactMap
    .map((v) =>
      scanFolder({
        bucketPrebuilt: argv.bucketPrebuilt,
        artifact: v,
        version,
      })
    )
    .flat();
};

type ScanFolder = {
  bucketPrebuilt: string;
  artifact: string;
  version: string;
};

const scanFolder = ({
  bucketPrebuilt,
  artifact,
  version,
}: ScanFolder): Array<any> => {
  const s3Objects = awsCall(
    [
      "s3api",
      "list-objects-v2",
      `--bucket ${bucketPrebuilt}`,
      `--prefix ${artifact}/${version}/`,
      "--output json",
    ],
    SPAWN_OPTS
  )?.stdout.toString("utf-8");
  const items = JSON.parse(s3Objects)?.Contents;
  return Array.isArray(items) ? items : [];
};

function awsOutput(args: Array<string>) {
  const result = awsCall(args, SPAWN_OPTS);
  return result.output
    .filter((e) => e && e.length > 0)
    .toString()
    .trimEnd();
}

function awsCall(
  args: Array<string>,
  opts: { [key: string]: string | boolean }
) {
  console.log(`$ aws ${args.join(" ")}`);
  const result = spawnSync("aws", args, opts);
  if (result.status !== 0) {
    throw new Error(`Failed to call aws with status ${result.status}`);
  }
  return result;
}

const getArtifactMap = () => {
  const cwd = process.cwd();
  const artifacts = globSync("artifact*/package.json")
    .map((v) => getArtifactName(cwd, v))
    .filter((v) => v);
  return artifacts.length > 0 ? artifacts : [getArtifactName(cwd)];
};

const getArtifactName = (cwd = process.cwd(), link = "package.json") => {
  return JSON.parse(
    fs.readFileSync(path.join(cwd || process.cwd(), link)).toString("utf-8")
  )?.name?.split("/")?.[1];
};

const currentVersion = (argv: Argv): string => {
  return argv.pullRequestTitle?.split(" v")?.[1] ?? "";
};

const formatVersion = (str: string) => {
  const { major, version } = semver.parse(str) as any;
  return `v${major}/v${version}`;
};

const getQaInfo = (argv: Argv) => {
  const versionMap = argv.pullRequestTitle
    ? argv.pullRequestTitle.split(" v")[1].split(".")
    : (argv.manualVersion ?? "").split(".");
  const version = `${versionMap[0]}.${versionMap[1]}`;
  return QA_INFO_CONTRAST.find(
    (v) => v.version === version && v.repo === argv.repo
  );
};
