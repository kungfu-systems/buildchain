import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
const target = process.env.INPUT_TARGET_BRANCH || process.env.GITHUB_REF_NAME || "";
if (!/^dev\/v\d+\/v\d+\.\d+$/u.test(target)) throw new Error("target-branch must be a semver dev branch, such as dev/v4/v4.1");
writeGitHubOutputs({ branch: target, "branch-artifact": target.replaceAll("/", "-") });
