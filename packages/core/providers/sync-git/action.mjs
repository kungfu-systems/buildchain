import { gitTransferRequest, transferGit } from "./transfer.mjs";
const request = gitTransferRequest({
  host: process.env.REMOTE_HOST,
  remotePath: process.env.REMOTE_PATH,
  repository: process.env.REMOTE_REPOSITORY,
  ref: process.env.SOURCE_REF,
  force: process.env.FORCE_PUSH === "true",
  credential: process.env.REMOTE_CREDENTIAL,
  user: process.env.REMOTE_USER,
});
transferGit(request);
