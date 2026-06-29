import { dispatch, Argv } from "./lib";
// import * as yargs from 'yargs';
const yargs = require("yargs");
const cmdArgv = yargs(process.argv.slice(2))
  .option("token", { description: "token", type: "string", default: "" })
  .option("bucketPrebuilt", {
    description: "bucketPrebuilt",
    type: "string",
    default: "kungfu-prebuilt",
  })
  .option("owner", { description: "owner", type: "string" })
  .option("repo", { description: "repo", type: "string" })
  .option("qaRepo", { description: "qaRepo", type: "string" })
  .help()
  .parseSync();

const argv: Argv = {
  token: cmdArgv.token,
  bucketPrebuilt: cmdArgv.bucketPrebuilt,
  owner: cmdArgv.owner,
  repo: cmdArgv.repo,
  qaRepo: cmdArgv.qaRepo,
};

dispatch(argv).catch(console.error);
