import { spawnSyncCommand } from "../../runtime/spawn-command.js";
import { requireValue } from "../../runtime/action-process.mjs";

export function assertBranchUnlocked(env, spawn = spawnSyncCommand) {
  const branch = encodeURIComponent(env.TARGET_BRANCH);
  const endpoint = `repos/${env.GITHUB_REPOSITORY}`;
  const read = (api) =>
    spawn("gh", ["api", api], { encoding: "utf8", shell: false, env });
  const protection = read(`${endpoint}/branches/${branch}/protection`);
  requireValue(!protection.error, "Unable to read branch protection");
  let locked = false;
  if (protection.status === 0)
    locked = JSON.parse(protection.stdout).lock_branch?.enabled === true;
  else
    requireValue(
      /HTTP 404/u.test(protection.stderr || ""),
      "Unable to read branch protection",
    );
  const rules = read(`${endpoint}/rules/branches/${branch}`);
  requireValue(
    !rules.error && rules.status === 0,
    "Unable to read applied branch rules",
  );
  const applied = JSON.parse(rules.stdout);
  requireValue(Array.isArray(applied), "Applied branch rules must be a list");
  locked ||= applied.some((rule) => rule.type === "update");
  requireValue(
    !locked,
    "Protected branch is locked by classic protection or an applied update rule; native merge queue admission cannot change a locked branch",
  );
}
