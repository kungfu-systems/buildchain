import { dispatch, Argv } from "./lib";
import { getInput, setFailed } from "@actions/core";
import { context } from "@actions/github";

const main = async function () {
  const argv: Argv = {
    token: getInput("token"),
    bucketPrebuilt: getInput("bucket-prebuilt"),
    qaRepo: getInput("qa_automated_repo"),
    manualArtifactName: getInput("manual_artifact_name"),
    manualVersion: getInput("manual_version"),
    repo: getInput("manual_repo") || context.payload.repository?.name || "",
    owner: context.payload.repository?.owner.login!,
    pullRequestTitle: context.payload?.pull_request?.title,
  };
  console.log({
    bucketPrebuilt: getInput("bucket-prebuilt"),
    qaRepo: getInput("qa_automated_repo"),
    manualArtifactName: getInput("manual_artifact_name"),
    manualVersion: getInput("manual_version"),
    repo: getInput("manual_repo") || context.payload.repository?.name || "",
    owner: context.payload.repository?.owner.login!,
    pullRequestTitle: context.payload?.pull_request?.title,
  });
  await dispatch(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    setFailed(error.message);
  });
}
