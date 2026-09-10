import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { selectGithubTokenAction } from "../../../../packages/core/providers/github-token.js";

await runAction(selectGithubTokenAction);
