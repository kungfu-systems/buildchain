import { verifyReleaseLineage } from "../line/verification.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
const env = process.env;
const outputs = verifyReleaseLineage({ workspace: env.BUILDCHAIN_SOURCE_CWD || process.cwd(), headRef: env.BUILDCHAIN_HEAD_REF || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME, baseRef: env.BUILDCHAIN_BASE_REF || env.GITHUB_BASE_REF || env.GITHUB_REF_NAME });
writeGitHubOutputs(outputs);
console.log(`release PR verified: ${outputs["head-ref"]} -> ${outputs["base-ref"]} (${outputs.keyword}, ${outputs.version})`);
