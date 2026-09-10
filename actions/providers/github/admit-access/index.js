import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitGithubAccessAction } from "../../../../packages/core/providers/github-token.js";

await runAction(admitGithubAccessAction);
