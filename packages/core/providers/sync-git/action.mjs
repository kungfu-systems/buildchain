import { gitTransferRequest, transferGit } from "./transfer.mjs";

export function synchronizeGitAction(core) {
  const credential = core.getInput("remote-credential");
  if (credential) core.setSecret(credential);
  const request = gitTransferRequest({
    host: core.getInput("remote-host", { required: true }),
    remotePath: core.getInput("remote-path", { required: true }),
    repository: core.getInput("remote-repo", { required: true }),
    ref: core.getInput("source-ref", { required: true }),
    force: core.getBooleanInput("force"),
    credential,
    user: core.getInput("remote-user"),
  });
  return transferGit(request);
}
