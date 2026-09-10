import { command } from "../../runtime/action-process.mjs";
import { planReleaseLineBootstrap } from "../release-line-bootstrap.js";
export function planLine(
  {
    sourceRoot,
    major,
    minor,
    sourceRef,
    initialVersion,
    requiredStatusCheck,
    setDefault,
    createAlphaPr,
  },
  execute = command,
) {
  const status = execute(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: sourceRoot, stdio: "pipe" },
  );
  if (status.trim())
    throw new Error("Release line bootstrap requires a clean source checkout");
  const plan = planReleaseLineBootstrap({
    cwd: sourceRoot,
    major,
    minor,
    sourceRef,
    initialVersion,
    requiredStatusCheck,
    setDefault,
    createAlphaPr,
  });
  if (!/^[0-9a-f]{40}$/u.test(plan.source.sha))
    throw new Error("Release line source must be an exact commit");
  return plan;
}
export function lineBootstrapSummary(plan, applied) {
  return [
    applied ? "## Release line bootstrap" : "## Release line bootstrap dry run",
    "",
    `- line: ${plan.line}`,
    `- source: ${plan.source.ref} @ ${plan.source.sha}`,
    `- dev: ${plan.refs.dev}`,
    `- alpha: ${plan.refs.alpha}`,
    `- release: ${plan.refs.release}`,
    `- initial version: ${plan.initialVersion}`,
    `- merge queue mode: ${plan.governance.mergeQueue.mode}`,
    "",
    ...(applied
      ? []
      : [
          "Re-run with `apply=true` to create refs, protection, default branch, and alpha PR.",
          "",
        ]),
  ].join("\n");
}
