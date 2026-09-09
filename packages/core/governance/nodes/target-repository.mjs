import { repositoryCoordinates } from "./coordinates.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
writeGitHubOutputs(repositoryCoordinates(process.env.INPUT_REPOSITORY, process.env.GITHUB_REPOSITORY));
