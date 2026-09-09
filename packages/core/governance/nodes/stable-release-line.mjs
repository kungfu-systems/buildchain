import { stableReleaseCoordinates } from "./coordinates.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
writeGitHubOutputs(stableReleaseCoordinates(process.env.INPUT_TARGET_BRANCH, process.env.GITHUB_REF_NAME));
